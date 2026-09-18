import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
    history.record("profile", "https://example.com/page", "Example");
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
  store.record("one", "https://example.org/report", "Quarterly report");
  store.recordVisit({
    profileId: "one",
    visit: {
      target: {
        kind: "file",
        projectId: "project",
        resource: "reports/quarter.md",
      },
      title: "Quarterly report",
      projectName: "Acme",
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
    store.record("one", url, "Secret");
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
