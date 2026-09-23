import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HistoryStore } from "./browser-history.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("HistoryStore", () => {
  it("returns the last observed favicon with recent pages", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "browser-history-"));
    dirs.push(dir);
    const history = new HistoryStore(dir);
    history.record({
      profileId: "profile",
      url: "https://example.com/page",
      title: "Example",
    });
    history.setFavicon(
      "profile",
      "https://example.com/page",
      "https://example.com/icon.png",
    );

    expect(history.suggest("profile", "example", 1)).toEqual([
      {
        url: "https://example.com/page",
        title: "Example",
        faviconUrl: "https://example.com/icon.png",
      },
    ]);
    history.dispose();
  });
});

it("merges repeated imports without changing dates or multiplying counts, and persists across reopen", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "history-merge-"));
  dirs.push(dir);
  const store = new HistoryStore(dir);
  const lastVisitAt = Date.now() - 7 * 86_400_000;
  const entries = [
    {
      url: "https://example.org/page",
      title: "Research",
      lastVisitAt,
      visitCount: 5,
    },
  ];
  expect(store.import({ profileId: "one", entries })).toBe(1);
  expect(store.import({ profileId: "one", entries })).toBe(0);
  expect(store.query({ profileId: "one" }).entries[0]).toMatchObject({
    lastVisitAt,
    visitCount: 5,
  });
  store.dispose();
  const reopened = new HistoryStore(dir);
  expect(reopened.query({ profileId: "one", query: "research" }).total).toBe(1);
  expect(reopened.query({ profileId: "two" }).total).toBe(0);
  reopened.dispose();
});

it("searches all surface types while web suggestions remain web-only, and supports removal and clear", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "history-resource-"));
  dirs.push(dir);
  const store = new HistoryStore(dir);
  store.record({
    profileId: "one",
    url: "https://example.org/report",
    title: "Quarterly report",
  });
  store.recordVisit({
    profileId: "one",
    visit: {
      target: {
        kind: "file",
        projectId: "project",
        resource: "reports/quarter.md",
      },
      title: "Quarterly report",
      project: { id: "project", name: "Acme" },
    },
  });
  expect(store.query({ profileId: "one", query: "quarterly" }).total).toBe(2);
  const match = store.query({ profileId: "one", query: "acme quarter" })
    .entries[0];
  expect(match?.target.kind).toBe("file");
  expect(store.suggest("one", "quarterly", 10)).toHaveLength(1);
  if (match) store.remove({ profileId: "one", id: match.id });
  expect(store.query({ profileId: "one" }).total).toBe(1);
  store.clear("one");
  expect(store.query({ profileId: "one" }).total).toBe(0);
  store.dispose();
});

it("never records auth callbacks, credentials in URLs, or non-web protocols", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "history-auth-"));
  dirs.push(dir);
  const store = new HistoryStore(dir);
  for (const url of [
    "https://github.com/login/device",
    "https://app.test/callback?code=secret",
    "https://app.test/?access_token=secret",
    "https://app.test/#access_token=secret",
    "https://user:secret@app.test/",
    "file:///tmp/secret",
  ])
    store.record({ profileId: "one", url, title: "Secret" });
  expect(store.query({ profileId: "one" }).total).toBe(0);
  store.dispose();
});

it("updates a resource title without adding a visit or restoring removed history", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "history-metadata-"));
  dirs.push(directory);
  const store = new HistoryStore(directory);
  const visit = {
    target: {
      kind: "chat",
      projectId: "project",
      resource: "session",
    } as const,
    title: "Chat",
  };
  store.recordVisit({ profileId: "profile", visit });
  const before = store.query({ profileId: "profile" }).entries[0]?.lastVisitAt;
  store.recordVisit({
    profileId: "profile",
    visit: { ...visit, title: "Named conversation" },
    revisit: false,
  });
  expect(store.query({ profileId: "profile" }).entries[0]).toMatchObject({
    title: "Named conversation",
    visitCount: 1,
    lastVisitAt: before,
  });
  store.clear("profile");
  store.recordVisit({ profileId: "profile", visit, revisit: false });
  expect(store.query({ profileId: "profile" }).total).toBe(0);
  store.dispose();
});

it("keeps files outside any project, scopes by the project a visit named, and lists those projects", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "history-projects-"));
  dirs.push(dir);
  const store = new HistoryStore(dir);
  const acme = { id: "acme", name: "Acme" };
  const lab = { id: "lab", name: "Lab" };
  // Each visit lands later than the one before.
  let now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => ++now);
  store.recordVisit({
    profileId: "one",
    visit: {
      target: { kind: "local", path: "/Users/me/Downloads/notes.txt" },
      title: "notes.txt",
      project: acme,
    },
  });
  store.recordVisit({
    profileId: "one",
    visit: {
      target: { kind: "file", projectId: "lab", resource: "README.md" },
      title: "README.md",
      project: lab,
    },
  });
  store.record({
    profileId: "one",
    url: "https://example.org/",
    title: "Example",
  });
  // The same page seen from a project now belongs to that project.
  store.record({
    profileId: "one",
    url: "https://example.org/",
    title: "Example",
    project: { id: "lab", name: "Lab renamed" },
  });
  const all = store.query({ profileId: "one" });
  expect(all.total).toBe(3);
  expect(all.projects).toEqual([{ id: "lab", name: "Lab renamed" }, acme]);
  expect(
    store
      .query({ profileId: "one", projectId: "acme" })
      .entries.map((entry) => entry.target),
  ).toEqual([{ kind: "local", path: "/Users/me/Downloads/notes.txt" }]);
  expect(store.query({ profileId: "one", projectId: "lab" }).total).toBe(2);
  expect(store.query({ profileId: "one", query: "downloads" }).total).toBe(1);
  // Local files are identified by path alone, whatever project saw them.
  store.recordVisit({
    profileId: "one",
    visit: {
      target: { kind: "local", path: "/Users/me/Downloads/notes.txt" },
      title: "notes.txt",
    },
  });
  expect(store.query({ profileId: "one" }).total).toBe(3);
  expect(store.query({ profileId: "one", projectId: "acme" }).total).toBe(0);
  expect(store.suggest("one", "notes", 5)).toEqual([]);
  vi.restoreAllMocks();
  store.dispose();
});
