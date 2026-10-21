// @vitest-environment jsdom
import { createApiClient } from "@catamorphic/api-client";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { chatBookmarkUrl } from "../../shared/bookmark-target.js";
import type { ResourceSnapshot } from "../../shared/resources.js";
import type { WorkspaceTab } from "../lib/workspace-types.js";
import type { WorkSourceDeps, WorkSourceHost } from "./deps.js";
import { resourcesSource } from "./processes.js";

const mocks = vi.hoisted(() => ({
  ended: [] as number[],
  killed: [] as string[],
  snapshot: undefined as ResourceSnapshot | undefined,
}));
vi.mock("../lib/desktop-api.js", () => ({
  desktopApi: {
    resourcesRead: async () => mocks.snapshot,
    resourcesEnd: async (pid: number) => {
      mocks.ended.push(pid);
    },
    terminalKill: async (id: string) => {
      mocks.killed.push(id);
    },
  },
}));
afterEach(() => {
  mocks.ended = [];
  mocks.killed = [];
});

const signal = new AbortController().signal;
const proc = (
  pid: number,
  extra: Partial<ResourceSnapshot["groups"][number]["processes"][number]> = {},
) => ({
  pid,
  name: `proc ${pid}`,
  command: `proc ${pid} --flag`,
  cpu: 10,
  memory: 50 * 1024 * 1024,
  history: [0, 10],
  endable: true,
  ...extra,
});
mocks.snapshot = {
  at: 0,
  cores: 8,
  totalMemory: 16 * 1024 ** 3,
  children: true,
  cpu: 140,
  memory: 2 * 1024 ** 3,
  history: [100, 140],
  groups: [
    {
      id: "work",
      owner: { kind: "work" },
      processes: [proc(1, { name: "Main process", endable: false })],
      cpu: 5,
      memory: 300 * 1024 * 1024,
      history: [5],
    },
    {
      id: "chat:s1",
      owner: { kind: "chat", sessionId: "s1", projectId: "p" },
      processes: [proc(10, { cpu: 120 }), proc(11, { parentPid: 10 })],
      cpu: 130,
      memory: 100 * 1024 * 1024,
      history: [50, 130],
    },
    {
      id: "terminal:t1",
      owner: { kind: "terminal", terminalId: "t1", title: "zsh" },
      processes: [proc(20)],
      cpu: 0,
      memory: 10 * 1024 * 1024,
      history: [0],
    },
    {
      id: "page:7",
      owner: {
        kind: "page",
        webContentsId: 7,
        title: "Example",
        url: "https://example.com",
      },
      processes: [proc(30, { endable: false })],
      cpu: 5,
      memory: 90 * 1024 * 1024,
      history: [5],
    },
  ],
};

const tabs: WorkspaceTab[] = [
  { kind: "chat", name: "c1", label: "Fix login", sessionId: "s1" },
  { kind: "browser", name: "b1", label: "Example Domain" },
];

function deps(host: Partial<WorkSourceHost> = {}): WorkSourceDeps {
  const value: WorkSourceHost = {
    tabs,
    tabGroups: [],
    unreadSessionIds: new Set(),
    agentName: () => undefined,
    closeTab: vi.fn(),
    reorderTab: vi.fn(),
    attachTab: vi.fn(),
    sessionAction: vi.fn(),
    openTab: vi.fn(),
    resourceTab: (owner) => (owner.kind === "page" ? "browser:b1" : undefined),
    ...host,
  };
  return {
    projectId: "p",
    apiClient: createApiClient({ baseUrl: "http://test", fetch: vi.fn() }),
    queryClient: new QueryClient(),
    writesProgram: true,
    remote: false,
    host: () => value,
    onWindowChange: () => () => {},
  };
}

it("lists a total, then owners named as the window knows them, with CPU as a trend", async () => {
  const source = resourcesSource(deps());
  const { items } = await source.load({ parentId: null, signal });
  expect(items.map((item) => [item.id, item.label, item.description])).toEqual([
    ["total", "Total", "2.0 GB"],
    ["work", "Work", "300 MB"],
    ["chat:s1", "Fix login", "100 MB"],
    ["terminal:t1", "Terminal (zsh)", "10 MB"],
    ["page:7", "Example Domain", "90 MB"],
  ]);
  const chat = items[2];
  expect(chat?.url).toBe(chatBookmarkUrl({ projectId: "p", sessionId: "s1" }));
  // A reading past most of a core warns; the line spans its own peak.
  expect(chat?.trend).toEqual({
    values: [50 / 130, 1],
    label: "130%",
    tone: "warning",
  });
  expect(items[4]?.url).toBe("browser:b1");
  // A quiet line still spans a fifth of a core.
  expect(items[1]?.trend?.values).toEqual([5 / 20]);
  // Work's own offers nothing to end.
  expect(items[1]?.menu).toEqual([]);
});

it("names and opens a chat through its own project, not the window's", async () => {
  const requested: string[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    requested.push(input instanceof Request ? input.url : String(input));
    return new Response(
      JSON.stringify({ snapshot: { session: { title: "Ship it" } } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  const previous = mocks.snapshot;
  mocks.snapshot = {
    ...(previous as ResourceSnapshot),
    groups: [
      {
        id: "chat:s2",
        owner: { kind: "chat", sessionId: "s2", projectId: "elsewhere" },
        processes: [proc(40)],
        cpu: 10,
        memory: 50 * 1024 * 1024,
        history: [10],
      },
    ],
  };
  try {
    const source = resourcesSource({
      ...deps(),
      apiClient: createApiClient({ baseUrl: "http://test", fetch }),
    });
    const first = await source.load({ parentId: null, signal });
    expect(first.items[1]).toMatchObject({
      label: "Chat",
      url: chatBookmarkUrl({ projectId: "elsewhere", sessionId: "s2" }),
    });
    await vi.waitFor(() => expect(requested).toHaveLength(1));
    expect(requested[0]).toBe(
      "http://test/api/projects/elsewhere/agent/sessions/s2",
    );
    await vi.waitFor(async () => {
      const { items } = await source.load({ parentId: null, signal });
      expect(items[1]?.label).toBe("Ship it");
    });
  } finally {
    mocks.snapshot = previous;
  }
});

it("nests an owner's processes, endable ones with End", async () => {
  const source = resourcesSource(deps());
  const { items } = await source.load({ parentId: "chat:s1", signal });
  expect(
    items.map((item) => [item.id, item.parentId, item.actions?.[0]?.action]),
  ).toEqual([
    ["pid:10", "chat:s1", "end"],
    ["pid:11", "chat:s1", "end"],
  ]);
  expect(items[0]?.preview).toMatchObject({
    description: "proc 10 --flag",
    metadata: [
      { label: "Process ID", value: "10" },
      { label: "CPU", value: "120%" },
      { label: "Memory", value: "50 MB" },
    ],
  });
  // Work's own keep their place for End, and say why it stays.
  const page = await source.load({ parentId: "page:7", signal });
  expect(page.items[0]?.actions?.[0]?.disabledReason).toBe(
    "Work needs this to keep running",
  );
  expect(page.items[0]?.contextMenu).toEqual([]);
  // Total opens to the busiest processes anywhere.
  const busiest = await source.load({ parentId: "total", signal });
  expect(busiest.items.map((item) => item.id)).toEqual([
    "top:10",
    "top:1",
    "top:11",
    "top:20",
    "top:30",
  ]);
});

it("ends a process, an owner's roots, and closes tabs and terminals through the window", async () => {
  const closeTab = vi.fn();
  const source = resourcesSource(deps({ closeTab }));
  await source.load({ parentId: null, signal });
  await source.action?.({ itemId: "pid:11", action: "end", signal });
  await source.action?.({ itemId: "top:20", action: "end", signal });
  // The chat's root takes its child with it.
  await source.action?.({ itemId: "chat:s1", action: "end", signal });
  expect(mocks.ended).toEqual([11, 20, 10]);
  await source.action?.({ itemId: "page:7", action: "close", signal });
  expect(closeTab).toHaveBeenCalledWith("browser:b1");
  // A terminal with no tab here ends through its session.
  await source.action?.({ itemId: "terminal:t1", action: "close", signal });
  expect(mocks.killed).toEqual(["t1"]);
});

it("reads every open branch again while shown", async () => {
  vi.useFakeTimers();
  try {
    const source = resourcesSource(deps());
    const changes: unknown[] = [];
    const stop = source.subscribe?.((change) => changes.push(change), {
      branches: () => [null, "total", "chat:s1"],
      branchSize: () => 0,
      fail: () => {},
    });
    vi.advanceTimersByTime(2_000);
    expect(changes).toEqual([
      { type: "invalidate", parentId: null, quiet: true },
      { type: "invalidate", parentId: "total", quiet: true },
      { type: "invalidate", parentId: "chat:s1", quiet: true },
    ]);
    stop?.();
    vi.advanceTimersByTime(4_000);
    expect(changes).toHaveLength(3);
  } finally {
    vi.useRealTimers();
  }
});
