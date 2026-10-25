// @vitest-environment jsdom
import { createApiClient } from "@catamorphic/api-client";
import { type Collection, createCollection } from "@catamorphic/app";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { chatBookmarkUrl } from "../../shared/bookmark-target.js";
import type { SidebarSourceItem } from "../../shared/sidebar-source.js";
import { remoteQueryClients } from "../lib/remote-query-clients.js";
import { SIDEBAR_SESSION_PAGE } from "../lib/sidebar-sessions.js";
import { chatsSource } from "./chats.js";
import type { WorkSourceDeps } from "./deps.js";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  hints: new Set<() => void>(),
  actions: vi.fn(),
}));
const apiClient = createApiClient({
  baseUrl: "http://sidebar.test",
  fetch: mocks.fetch,
});
vi.mock("../lib/desktop-api.js", () => ({
  desktopApi: {
    onSessionsChanged: (listener: () => void) => {
      mocks.hints.add(listener);
      return () => mocks.hints.delete(listener);
    },
    sessionCheckouts: async () => [
      { sessionId: "c1", kind: "managed", branch: "fix-login" },
    ],
  },
}));
/** This computer says its chats may have changed (ADR 0229). */
const hint = () => {
  for (const listener of mocks.hints) listener();
};
/** Every view's root lease, released after each test even when it fails. */
const leases: Array<() => void> = [];
afterEach(() => {
  for (const release of leases.splice(0)) release();
  vi.useRealTimers();
  mocks.fetch.mockReset();
  mocks.actions.mockReset();
});

/** A newest-first project of `count` promoted chats, `c0` the newest. */
function chatList(
  count: number,
  extra: Array<{
    id: string;
    visibility?: string;
    parentSessionId?: string | null;
    /** Its age in chats: 4.5 sits between c4 and c5. */
    age: number;
  }> = [],
) {
  const created = (index: number) =>
    new Date(Date.UTC(2026, 0, 1) - index * 60_000).toISOString();
  const row = (id: string, age: number) => ({
    id,
    title: `Chat ${id}`,
    visibility: "promoted",
    parentSessionId: null as string | null,
    childCount: 0,
    running: false,
    attentionRequired: false,
    owner: "user",
    status: "active",
    agentId: null,
    createdAt: created(age),
  });
  const chats = Array.from({ length: count }, (_, index) =>
    row(`c${index}`, index),
  );
  const others = extra.map((chat) => ({
    ...row(chat.id, chat.age),
    visibility: chat.visibility ?? "promoted",
    parentSessionId: chat.parentSessionId ?? null,
  }));
  const pages: URL[] = [];
  const reads: string[] = [];
  mocks.fetch.mockImplementation(async (request: Request) => {
    const url = new URL(request.url);
    const single = url.pathname.match(/\/agent\/sessions\/([^/]+)$/);
    if (single) {
      reads.push(single[1] ?? "");
      const chat = [...chats, ...others].find(({ id }) => id === single[1]);
      return chat
        ? Response.json(chat)
        : Response.json({ error: "Not found" }, { status: 404 });
    }
    pages.push(url);
    const offset = Number(url.searchParams.get("offset"));
    const limit = Number(url.searchParams.get("limit"));
    return Response.json({
      items: chats.slice(offset, offset + limit),
      total: chats.length,
    });
  });
  return { chats, pages, reads, created };
}

function view(projectId = "paged") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const deps: WorkSourceDeps = {
    projectId,
    apiClient,
    queryClient: client,
    writesProgram: true,
    remote: false,
    host: () => ({
      tabs: [],
      tabGroups: [],
      unreadSessionIds: new Set(["c2"]),
      agentName: () => "Claude",
      closeTab: () => {},
      reorderTab: () => {},
      attachTab: () => {},
      sessionAction: mocks.actions,
      openTab: () => {},
      resourceTab: () => undefined,
    }),
    onWindowChange: () => () => {},
  };
  const source = chatsSource(deps, "chats");
  const parents = new Set<string | null>();
  const subscribe = source.subscribe;
  const collection: Collection<SidebarSourceItem> = createCollection({
    source: {
      load: (request) => {
        parents.add(request.parentId);
        return source.load(request);
      },
      ...(subscribe
        ? {
            subscribe: (publish) =>
              subscribe(publish, {
                branches: () => [...parents],
                branchSize: (parentId) =>
                  collection.getBranch(parentId).ids.length,
                fail: () => {},
              }),
          }
        : {}),
    },
  });
  return { client, source, collection };
}

/** Acquire the root as the tree does and read until `rows` are loaded. */
async function loadRows(
  collection: Collection<SidebarSourceItem>,
  rows: number,
) {
  const release = collection.acquire();
  leases.push(release);
  await vi.waitFor(() =>
    expect(collection.getBranch(null).status).toBe("ready"),
  );
  while (
    collection.getBranch(null).ids.length < rows &&
    collection.getBranch(null).cursor
  )
    await collection.load({ more: true });
  return release;
}

it("draws a chat as a row: its address, signals, branch and own verbs", async () => {
  chatList(3);
  const { collection, source, client } = view();
  const release = await loadRows(collection, 3);
  expect(collection.getItem("c1")).toMatchObject({
    url: chatBookmarkUrl({ projectId: "paged", sessionId: "c1" }),
    icon: "MessageSquare",
    badges: [{ label: "fix-login", icon: "GitBranch" }],
    menu: [
      { action: "rename" },
      { action: "new-subsession" },
      { action: "open-terminal" },
      { action: "mark-unread" },
      { action: "archive" },
    ],
    data: { id: "c1" },
  });
  expect(collection.getItem("c2")).toMatchObject({ signal: "unread" });
  await source.action?.({
    itemId: "c1",
    action: "archive",
    signal: new AbortController().signal,
  });
  expect(mocks.actions).toHaveBeenCalledWith("c1", "archive");
  expect(
    await source.action?.({
      itemId: "c1",
      action: "open-tab",
      signal: new AbortController().signal,
    }),
  ).toEqual({
    open: chatBookmarkUrl({ projectId: "paged", sessionId: "c1" }),
    mode: "tab",
  });
  release();
  client.clear();
});

it("asks the window to rename a chat, in the one rename dialog", async () => {
  chatList(1);
  const { source, client } = view();
  await source.action?.({
    itemId: "c0",
    action: "rename",
    signal: new AbortController().signal,
  });
  expect(mocks.actions).toHaveBeenCalledWith("c0", "rename");
  client.clear();
});

it("says which tool a chat run outside Work came from", async () => {
  const { chats } = chatList(1);
  Object.assign(chats[0] ?? {}, {
    imported: { harness: "codex", nativeSessionId: "rollout-1" },
  });
  const { collection, client } = view();
  const release = await loadRows(collection, 1);
  const row = collection.getItem("c0");
  expect(row?.badges).toEqual([{ label: "Codex" }]);
  expect(row?.preview).toMatchObject({
    metadata: expect.arrayContaining([{ label: "From", value: "Codex" }]),
  });
  release();
  client.clear();
});

it("starts a next page five rows early and merges the repeats", async () => {
  const { chats, pages } = chatList(SIDEBAR_SESSION_PAGE * 2 + 4);
  const { collection, client } = view();
  const release = await loadRows(collection, 1);
  expect(collection.getBranch(null).ids).toHaveLength(SIDEBAR_SESSION_PAGE);
  await collection.load({ more: true });
  expect(pages.at(-1)?.searchParams.get("offset")).toBe(
    String(SIDEBAR_SESSION_PAGE - 5),
  );
  const ids = collection.getBranch(null).ids;
  expect(ids).toHaveLength(SIDEBAR_SESSION_PAGE * 2 - 5);
  expect(new Set(ids).size).toBe(ids.length);
  const last = chats[SIDEBAR_SESSION_PAGE * 2 - 6];
  expect(collection.getBranch(null).cursor).toBe(
    `${SIDEBAR_SESSION_PAGE * 2 - 5}~${last?.createdAt}~${last?.id}`,
  );
  release();
  client.clear();
});

it("starts a page earlier when more chats went away than the overlap covers", async () => {
  const { chats, pages } = chatList(SIDEBAR_SESSION_PAGE * 3);
  const { collection, client } = view();
  const release = await loadRows(collection, 1);
  // Seven chats on the first page are archived elsewhere: every later
  // offset moves up by seven, past the five-row overlap.
  chats.splice(1, 7);
  await client.invalidateQueries({ refetchType: "none" });
  pages.length = 0;
  await collection.load({ more: true });
  expect(pages.map((url) => url.searchParams.get("offset"))).toEqual([
    String(SIDEBAR_SESSION_PAGE - 5),
    "0",
  ]);
  // The first chat past the loaded ones is read, not skipped.
  expect(collection.getBranch(null).ids).toContain(`c${SIDEBAR_SESSION_PAGE}`);
  release();
  client.clear();
});

it("reads on to the last row when more chats arrived above than the overlap covers", async () => {
  const { chats, pages } = chatList(SIDEBAR_SESSION_PAGE * 3);
  const { collection, client } = view();
  const release = await loadRows(collection, 1);
  expect(collection.getBranch(null).ids.at(-1)).toBe(
    `c${SIDEBAR_SESSION_PAGE - 1}`,
  );
  // More chats start than a page holds before a poll reads the loaded page
  // again: the overlap page is all newer rows, so the read goes on.
  const newest = chats[0];
  if (!newest) throw new Error("No chats");
  chats.unshift(
    ...Array.from({ length: SIDEBAR_SESSION_PAGE + 10 }, (_, index) => ({
      ...newest,
      id: `n${index}`,
      createdAt: new Date(Date.UTC(2026, 0, 2) - index * 60_000).toISOString(),
    })),
  );
  await client.invalidateQueries({ refetchType: "none" });
  pages.length = 0;
  await collection.load({ more: true });
  expect(pages.map((url) => url.searchParams.get("offset"))).toEqual([
    String(SIDEBAR_SESSION_PAGE - 5),
    String(SIDEBAR_SESSION_PAGE * 2 - 5),
  ]);
  // The rows after the last one read arrive, not the loaded ones again.
  expect(
    collection
      .getBranch(null)
      .ids.slice(SIDEBAR_SESSION_PAGE, SIDEBAR_SESSION_PAGE + 2),
  ).toEqual([`c${SIDEBAR_SESSION_PAGE}`, `c${SIDEBAR_SESSION_PAGE + 1}`]);
  release();
  client.clear();
});

it("reads a deep list's first page on a hint and every loaded page every 30 seconds", async () => {
  vi.useFakeTimers();
  const { pages } = chatList(SIDEBAR_SESSION_PAGE * 4);
  const { collection, client } = view();
  const release = await loadRows(collection, SIDEBAR_SESSION_PAGE * 2 + 10);
  await vi.waitFor(() =>
    expect(collection.getBranch(null).fetching).toBeFalsy(),
  );
  pages.length = 0;
  hint();
  await vi.advanceTimersByTimeAsync(1);
  // However deep the list is loaded, a hint reads one page.
  expect(pages.map((url) => url.searchParams.get("offset"))).toEqual(["0"]);
  pages.length = 0;
  await vi.advanceTimersByTimeAsync(29_000);
  expect(pages).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(1_000);
  await vi.waitFor(() =>
    expect(collection.getBranch(null).fetching).toBeFalsy(),
  );
  expect(pages.length).toBeGreaterThan(1);
  expect(pages[0]?.searchParams.get("offset")).toBe("0");
  release();
  client.clear();
});

it("reads a short list whole on every hint, so no loaded row lags", async () => {
  vi.useFakeTimers();
  const { pages } = chatList(SIDEBAR_SESSION_PAGE * 3);
  const { collection, client } = view();
  const release = await loadRows(collection, SIDEBAR_SESSION_PAGE + 1);
  await vi.waitFor(() =>
    expect(collection.getBranch(null).fetching).toBeFalsy(),
  );
  pages.length = 0;
  hint();
  await vi.advanceTimersByTimeAsync(1);
  await vi.waitFor(() =>
    expect(collection.getBranch(null).fetching).toBeFalsy(),
  );
  expect(pages.map((url) => url.searchParams.get("offset"))).toEqual([
    "0",
    String(SIDEBAR_SESSION_PAGE - 5),
  ]);
  release();
  client.clear();
});

it("polls a remote project's list, whose server sends no hints", async () => {
  vi.useFakeTimers();
  const { pages } = chatList(SIDEBAR_SESSION_PAGE * 4);
  const { collection, client } = view("remote-project");
  remoteQueryClients.set("connection:1", client);
  try {
    const release = await loadRows(collection, SIDEBAR_SESSION_PAGE * 2 + 10);
    await vi.waitFor(() =>
      expect(collection.getBranch(null).fetching).toBeFalsy(),
    );
    pages.length = 0;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(pages.map((url) => url.searchParams.get("offset"))).toEqual(["0"]);
    release();
  } finally {
    remoteQueryClients.delete("connection:1");
    client.clear();
  }
});

it("places an older open chat past the loaded rows, and nothing it does not hold", async () => {
  const { reads } = chatList(SIDEBAR_SESSION_PAGE * 3, [
    {
      id: "fork",
      parentSessionId: `c${SIDEBAR_SESSION_PAGE + 9}`,
      age: SIDEBAR_SESSION_PAGE + 9.5,
    },
    { id: "gone", visibility: "archived", age: SIDEBAR_SESSION_PAGE + 8.5 },
    { id: "fresh", age: 0.5 },
  ]);
  const { collection, source, client } = view();
  const release = await loadRows(collection, 1);
  const after = collection.getItem(collection.getBranch(null).ids.at(-1) ?? "");
  const reveal = (sessionId: string) =>
    source.reveal?.({
      url: chatBookmarkUrl({ projectId: "paged", sessionId }),
      after,
      signal: new AbortController().signal,
    });
  expect(await reveal(`c${SIDEBAR_SESSION_PAGE + 7}`)).toMatchObject({
    id: `c${SIDEBAR_SESSION_PAGE + 7}`,
    parentId: null,
    hasChildren: false,
  });
  // A fork shows as the top-level chat it hangs under.
  expect((await reveal("fork"))?.id).toBe(`c${SIDEBAR_SESSION_PAGE + 9}`);
  expect(await reveal("gone")).toBeNull();
  // Newer than the loaded rows: it arrives with the next poll instead.
  expect(await reveal("fresh")).toBeNull();
  expect(
    await source.reveal?.({
      url: chatBookmarkUrl({ projectId: "elsewhere", sessionId: "c1" }),
      after,
      signal: new AbortController().signal,
    }),
  ).toBeNull();
  expect(reads).toContain("fork");
  release();
  client.clear();
});
