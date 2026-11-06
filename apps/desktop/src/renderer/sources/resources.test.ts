// @vitest-environment jsdom
import { createApiClient } from "@catamorphic/api-client";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import type { WorkspaceTab } from "../lib/workspace-types.js";
import type { WorkSourceDeps, WorkSourceHost } from "./deps.js";
import { moduleSource } from "./module.js";
import { filesSource, tabsSource } from "./resources.js";

const mocks = vi.hoisted(() => ({
  files: [] as Array<{ path: string }>,
  changed: new Set<(event: { leaseId: string; error?: string }) => void>(),
  requests: [] as unknown[],
}));
vi.mock("../lib/desktop-api.js", () => ({
  desktopApi: {
    projectLocalFiles: async () => mocks.files,
    onGitChanged: () => () => {},
    sidebarSourceRequest: async (input: unknown) => {
      mocks.requests.push(input);
      return {
        items: [],
        capabilities: { move: true, drop: false, reveal: false },
      };
    },
    sidebarSourceCancel: async () => {},
    sidebarSourceSubscribe: async () => {},
    sidebarSourceUnsubscribe: async () => {},
    onSidebarSourceChanged: (
      listener: (event: { leaseId: string; error?: string }) => void,
    ) => {
      mocks.changed.add(listener);
      return () => mocks.changed.delete(listener);
    },
  },
}));
afterEach(() => {
  mocks.files = [];
  mocks.requests = [];
  mocks.changed.clear();
});

const signal = new AbortController().signal;
const tabs: WorkspaceTab[] = [
  {
    kind: "browser",
    name: "b1",
    label: "Docs",
    faviconUrl: "https://docs.example.com/icon.png",
    bookmarkUrl: "https://docs.example.com",
  },
  {
    kind: "chat",
    name: "c1",
    label: "Fix login",
    sessionId: "s1",
    working: true,
  },
  { kind: "browser", name: "b2", label: "Login page", groupId: "c1" },
  { kind: "chat", name: "c2", label: "Plan", sessionId: "s2", attention: true },
];

function deps(host: Partial<WorkSourceHost> = {}, writesProgram = true) {
  const listeners = new Set<() => void>();
  const hostValue: WorkSourceHost = {
    tabs,
    tabGroups: [{ parentKey: "chat:c1", memberKeys: ["browser:b2"] }],
    activeTabKey: "chat:c1",
    unreadSessionIds: new Set(),
    agentName: () => undefined,
    closeTab: vi.fn(),
    reorderTab: vi.fn(),
    attachTab: vi.fn(),
    sessionAction: vi.fn(),
    openTab: vi.fn(),
    resourceTab: () => undefined,
    ...host,
  };
  const value: WorkSourceDeps = {
    projectId: "p",
    apiClient: createApiClient({ baseUrl: "http://test", fetch: vi.fn() }),
    queryClient: new QueryClient(),
    writesProgram,
    remote: false,
    host: () => hostValue,
    onWindowChange: (_topic, listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    value,
    host: hostValue,
    changed: () => {
      for (const listener of listeners) listener();
    },
  };
}

it("lists the window's tabs with what their chats are doing, a chat's tabs under it", async () => {
  const { value, host } = deps();
  const source = tabsSource(value);
  const roots = await source.load({ parentId: null, signal });
  expect(roots.items.map((row) => row.id)).toEqual([
    "browser:b1",
    "chat:c1",
    "chat:c2",
  ]);
  expect(roots.items[0]).toMatchObject({
    url: "browser:b1",
    icon: "https://docs.example.com/icon.png",
    data: { kind: "browser", url: "https://docs.example.com" },
  });
  expect(roots.items[1]).toMatchObject({
    signal: "working",
    hasChildren: true,
    data: { active: true, working: true, sessionId: "s1" },
  });
  expect(roots.items[2]).toMatchObject({ signal: "attention" });
  expect(
    (await source.load({ parentId: "chat:c1", signal })).items.map(
      (row) => row.id,
    ),
  ).toEqual(["browser:b2"]);
  await source.action?.({ itemId: "browser:b1", action: "close", signal });
  expect(host.closeTab).toHaveBeenCalledWith("browser:b1");
  await source.move?.({
    itemId: "chat:c2",
    parentId: null,
    beforeId: "browser:b1",
    signal,
  });
  expect(host.reorderTab).toHaveBeenCalledWith("chat:c2", "browser:b1");
  expect(source.capabilities()).toEqual({
    move: true,
    drop: false,
    reveal: false,
  });
});

it("renames a chat's tab as its chat, in the window's one rename dialog", async () => {
  const { value, host } = deps();
  const source = tabsSource(value);
  const roots = await source.load({ parentId: null, signal });
  expect(roots.items[1]?.menu?.map((entry) => entry.action)).toEqual([
    "rename",
    "close",
  ]);
  expect(roots.items[0]?.menu?.map((entry) => entry.action)).toEqual(["close"]);
  await source.action?.({ itemId: "chat:c1", action: "rename", signal });
  expect(host.sessionAction).toHaveBeenCalledWith("s1", "rename");
  await expect(
    source.action?.({ itemId: "browser:b1", action: "rename", signal }),
  ).rejects.toThrow("This tab does not support that action");
});

it("follows the window's tabs, a chat's pages included", () => {
  const { value, changed } = deps();
  const publish = vi.fn();
  const stop = tabsSource(value).subscribe?.(publish, {
    branches: () => [null, "chat:c1"],
    branchSize: () => 0,
    fail: () => {},
  });
  changed();
  expect(publish.mock.calls).toEqual([
    [{ type: "invalidate", parentId: null }],
    [{ type: "invalidate", parentId: "chat:c1" }],
  ]);
  stop?.();
});

it("opens a chat's group, and nests a tab dropped on a chat there", async () => {
  const { value, host } = deps();
  const source = tabsSource(value);
  const roots = await source.load({ parentId: null, signal });
  expect(roots.items[1]).toMatchObject({
    id: "chat:c1",
    collapsed: false,
    acceptsChildren: true,
  });
  // A chat with nothing under it yet still takes a tab dropped on it.
  expect(roots.items[2]).toMatchObject({
    id: "chat:c2",
    hasChildren: false,
    acceptsChildren: true,
  });
  expect(roots.items[0]).not.toHaveProperty("collapsed");
  expect(roots.items[0]).not.toHaveProperty("acceptsChildren");
  await source.move?.({ itemId: "browser:b1", parentId: "chat:c2", signal });
  expect(host.attachTab).toHaveBeenCalledWith("browser:b1", "chat:c2", null);
  await source.move?.({
    itemId: "browser:b2",
    parentId: null,
    beforeId: "chat:c2",
    signal,
  });
  expect(host.attachTab).toHaveBeenLastCalledWith(
    "browser:b2",
    null,
    "chat:c2",
  );
  expect(host.reorderTab).not.toHaveBeenCalled();
  // Among the tabs beside it, it only changes places.
  await source.move?.({ itemId: "browser:b2", parentId: "chat:c1", signal });
  expect(host.reorderTab).toHaveBeenCalledWith("browser:b2", null);
  expect(host.attachTab).toHaveBeenCalledTimes(2);
  // A group folded in the strip has no pages in the window's tabs.
  const folded = tabsSource(
    deps({ tabs: tabs.filter((tab) => tab.name !== "b2") }).value,
  );
  expect(
    (await folded.load({ parentId: null, signal })).items[1],
  ).toMatchObject({ id: "chat:c1", hasChildren: false });
});

it("lists the project folder, and opens the store for a member", async () => {
  mocks.files = [
    { path: "README.md" },
    { path: "src/app.ts" },
    { path: ".work/app-data/store/notes.md" },
    { path: ".work/personal/u1/draft.md" },
    { path: ".git/config" },
  ];
  const builder = filesSource(deps().value);
  expect(
    (await builder.load({ parentId: null, signal })).items.map((row) => row.id),
  ).toEqual([".work", "src", "README.md"]);
  expect(
    (await builder.load({ parentId: "src", signal })).items[0],
  ).toMatchObject({ id: "src/app.ts", url: "file:src/app.ts", icon: "File" });
  expect(
    (await builder.load({ parentId: null, signal })).items[0],
  ).not.toHaveProperty("collapsed");
  // A member of a server project sees content: the store opens at once.
  const member = filesSource(deps({}, false).value);
  const roots = await member.load({ parentId: null, signal });
  expect(roots.items[0]).toMatchObject({ id: ".work", collapsed: false });
  const work = await member.load({ parentId: ".work", signal });
  expect(work.items.map((row) => row.id).sort()).toEqual([
    ".work/app-data",
    ".work/personal",
  ]);
});

it("reads a module again when a Work list it read changes", async () => {
  vi.useFakeTimers();
  try {
    let onRead: ((name: "tabs") => void) | undefined;
    const tabsListeners: Array<() => void> = [];
    const source = moduleSource({
      projectId: "p",
      ownerId: "sorted-tabs",
      work: {
        watchReads: (ownerId, listener) => {
          expect(ownerId).toBe("sorted-tabs");
          onRead = listener;
          return () => {};
        },
        get: () => ({
          title: "Tabs",
          empty: "",
          capabilities: () => ({ move: false, drop: false, reveal: false }),
          load: async () => ({ items: [] }),
          subscribe: (publish) => {
            tabsListeners.push(() => publish({ type: "invalidate" }));
            return () => {};
          },
        }),
      },
    });
    const publish = vi.fn();
    const stop = source.subscribe?.(publish, {
      branches: () => [null, "folder"],
      branchSize: () => 0,
      fail: () => {},
    });
    // The module reads Work's tabs while loading; from then on it follows them.
    onRead?.("tabs");
    onRead?.("tabs");
    expect(tabsListeners).toHaveLength(1);
    tabsListeners[0]?.();
    tabsListeners[0]?.();
    await vi.advanceTimersByTimeAsync(200);
    // A burst reads once, every loaded branch, quietly.
    expect(publish.mock.calls).toEqual([
      [{ type: "invalidate", parentId: null, quiet: true }],
      [{ type: "invalidate", parentId: "folder", quiet: true }],
    ]);
    stop?.();
  } finally {
    vi.useRealTimers();
  }
});

it("learns a module's capabilities from its pages", async () => {
  const seen = vi.fn();
  const source = moduleSource({
    projectId: "p",
    ownerId: "m",
    onCapabilities: seen,
  });
  expect(source.capabilities()).toEqual({
    move: false,
    drop: false,
    reveal: false,
  });
  await source.load({ parentId: null, signal });
  expect(source.capabilities()).toEqual({
    move: true,
    drop: false,
    reveal: false,
  });
  expect(seen).toHaveBeenCalledWith({ move: true, drop: false, reveal: false });
  expect(mocks.requests[0]).toMatchObject({ method: "load", sectionId: "m" });
});
