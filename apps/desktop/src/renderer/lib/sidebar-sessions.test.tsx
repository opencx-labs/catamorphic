// @vitest-environment jsdom
import { createApiClient } from "@catamorphic/api-client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { SidebarSectionConfig } from "../../shared/sidebar.js";
import {
  readSidebarSessionPage,
  SIDEBAR_SESSION_PAGE,
  useRevealSidebarSession,
  useSidebarSessions,
} from "./sidebar-sessions.js";

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
const apiClient = createApiClient({
  baseUrl: "http://sidebar.test",
  fetch: mocks.fetch,
});
vi.mock("@catamorphic/react", () => ({
  useCatamorphic: () => ({ apiClient }),
}));
afterEach(() => {
  vi.useRealTimers();
  mocks.fetch.mockReset();
});

it("shares session page IO and lets one consumer cancel without canceling another", async () => {
  const client = new QueryClient();
  let resolve: ((response: Response) => void) | undefined;
  mocks.fetch.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const first = new AbortController();
  const second = new AbortController();
  const args: Omit<Parameters<typeof readSidebarSessionPage>[0], "signal"> = {
    apiClient,
    client,
    projectId: "project",
    query: { limit: 50, offset: 0, rootsOnly: "true" },
  };
  const a = readSidebarSessionPage({ ...args, signal: first.signal });
  const b = readSidebarSessionPage({ ...args, signal: second.signal });
  const rejected = expect(a).rejects.toThrow();
  first.abort();
  expect(mocks.fetch).toHaveBeenCalledTimes(1);
  resolve?.(Response.json({ items: [{ id: "session" }], total: 1 }));
  await rejected;
  expect((await b).items[0]?.id).toBe("session");
  expect(
    (await readSidebarSessionPage({ ...args, signal: second.signal })).total,
  ).toBe(1);
  expect(mocks.fetch).toHaveBeenCalledTimes(1);
  client.clear();
});

it("refreshes one hidden page and restores the visible loaded depth", async () => {
  vi.useFakeTimers();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const requests: URL[] = [];
  mocks.fetch.mockImplementation(async (request: Request) => {
    const url = new URL(request.url);
    requests.push(url);
    const child = url.searchParams.has("parentSessionId");
    const more = url.searchParams.get("offset") === "1";
    return Response.json({
      items: [
        {
          id: child ? "child" : more ? "second" : "parent",
          title: "Chat",
          visibility: "promoted",
          childCount: child || more ? 0 : 1,
        },
      ],
      total: child ? 1 : 2,
    });
  });
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const node = document.createElement("div");
  const root = createRoot(node);
  let state: ReturnType<typeof useSidebarSessions> | undefined;
  function Probe({ visible }: { visible: boolean }) {
    state = useSidebarSessions({
      projectId: "project",
      section: {
        id: "chats",
        type: "chats",
        source: { type: "chats", pageSize: 1 },
      },
      visible,
      relevant: true,
    });
    return null;
  }
  const show = (visible: boolean) =>
    act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <Probe visible={visible} />
        </QueryClientProvider>,
      ),
    );
  await show(true);
  if (!state) throw new Error("Missing session store");
  const collection = state.collection;
  let releaseRoot = () => {};
  let releaseChild = () => {};
  await act(async () => {
    releaseRoot = collection.acquire();
  });
  await vi.waitFor(() =>
    expect(collection.getBranch(null).status).toBe("ready"),
  );
  await act(async () => {
    await collection.load({ more: true });
    releaseChild = collection.acquire({ parentId: "parent" });
  });
  await vi.waitFor(() =>
    expect(collection.getBranch("parent").status).toBe("ready"),
  );
  act(() => {
    releaseChild();
    releaseRoot();
  });
  await show(false);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(state?.root.status).toBe("ready");
  expect(collection.isAcquired()).toBe(true);
  expect(collection.getBranch(null).ids).toEqual(["parent"]);
  expect(collection.getItem("second")).toBeDefined();
  requests.length = 0;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2_001);
  });
  expect(requests).toHaveLength(1);
  expect(requests[0]?.searchParams.get("offset")).toBe("0");
  expect(requests[0]?.searchParams.has("parentSessionId")).toBe(false);
  await show(true);
  await act(async () => {
    releaseRoot = collection.acquire();
  });
  await vi.waitFor(() =>
    expect(collection.getBranch(null).ids).toEqual(["parent", "second"]),
  );
  releaseRoot();
  await act(async () => root.unmount());
  client.clear();
});

it("keeps a hidden empty section empty while its availability request is pending", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  mocks.fetch.mockResolvedValueOnce(Response.json({ items: [], total: 0 }));
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRoot(document.createElement("div"));
  let state: ReturnType<typeof useSidebarSessions> | undefined;
  function Probe({ visible }: { visible: boolean }) {
    state = useSidebarSessions({
      projectId: "empty",
      section: { id: "chats", type: "chats" },
      visible,
      relevant: true,
    });
    return null;
  }
  const show = (visible: boolean) =>
    act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <Probe visible={visible} />
        </QueryClientProvider>,
      ),
    );
  try {
    await show(true);
    if (!state) throw new Error("Missing store");
    await act(async () => {
      await state?.collection.load();
    });
    await client.invalidateQueries({ refetchType: "none" });
    mocks.fetch.mockImplementation(() => new Promise(() => {}));
    await show(false);
    expect(state.root.status).toBe("ready");
    expect(state.root.ids).toEqual([]);
  } finally {
    await act(async () => root.unmount());
    client.clear();
  }
});

/** A newest-first project of `count` promoted chats, `c0` the newest. */
function chatList(count: number) {
  const created = (index: number) =>
    new Date(Date.UTC(2026, 0, 1) - index * 60_000).toISOString();
  const chats = Array.from({ length: count }, (_, index) => ({
    id: `c${index}`,
    title: `Chat ${index}`,
    visibility: "promoted",
    parentSessionId: null,
    childCount: 0,
    createdAt: created(index),
  }));
  const pages: URL[] = [];
  const reads: string[] = [];
  mocks.fetch.mockImplementation(async (request: Request) => {
    const url = new URL(request.url);
    const single = url.pathname.match(/\/agent\/sessions\/([^/]+)$/);
    if (single) {
      reads.push(single[1] ?? "");
      return Response.json(
        chats.find((chat) => chat.id === single[1]) ?? {
          id: single[1],
          title: "Elsewhere",
          visibility: "promoted",
          parentSessionId: null,
          createdAt: new Date(
            Date.UTC(2026, 0, 1) - 4.5 * 60_000,
          ).toISOString(),
        },
      );
    }
    pages.push(url);
    const offset = Number(url.searchParams.get("offset"));
    const limit = Number(url.searchParams.get("limit"));
    return Response.json({
      items: chats.slice(offset, offset + limit),
      total: chats.length,
    });
  });
  return { chats, pages, reads };
}

function mountSessions({
  section,
  activeSessionId,
}: {
  section: SidebarSectionConfig;
  activeSessionId?: string;
}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRoot(document.createElement("div"));
  const state: { current?: ReturnType<typeof useSidebarSessions> } = {};
  function Probe() {
    const sessions = useSidebarSessions({
      projectId: "paged",
      section,
      visible: true,
      relevant: true,
    });
    state.current = sessions;
    useRevealSidebarSession({
      ...sessions,
      projectId: "paged",
      sessionId: activeSessionId,
      section,
      active: true,
    });
    return null;
  }
  return {
    state,
    mount: () =>
      act(async () =>
        root.render(
          <QueryClientProvider client={client}>
            <Probe />
          </QueryClientProvider>,
        ),
      ),
    unmount: async () => {
      await act(async () => root.unmount());
      client.clear();
    },
  };
}

it("polls only the first page and reads every loaded page every 30 seconds", async () => {
  vi.useFakeTimers();
  const { pages } = chatList(10);
  const view = mountSessions({
    section: {
      id: "polled",
      type: "chats",
      source: { type: "chats", pageSize: 3 },
    },
  });
  await view.mount();
  const collection = view.state.current?.collection;
  if (!collection) throw new Error("Missing session store");
  let release = () => {};
  await act(async () => {
    release = collection.acquire();
  });
  await vi.waitFor(() =>
    expect(collection.getBranch(null).status).toBe("ready"),
  );
  await act(async () => {
    await collection.load({ more: true });
    await collection.load({ more: true });
  });
  expect(collection.getBranch(null).ids).toHaveLength(9);
  pages.length = 0;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2_000);
  });
  // However deep the list is loaded, a poll reads one page.
  expect(pages.map((url) => url.searchParams.get("offset"))).toEqual(["0"]);
  pages.length = 0;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2_000 * 13);
  });
  expect(pages).toHaveLength(13);
  pages.length = 0;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2_000);
  });
  expect(pages.map((url) => url.searchParams.get("offset"))).toEqual([
    "0",
    "3",
    "6",
  ]);
  expect(collection.getBranch(null).ids).toHaveLength(9);
  // Coming back to the window reads everything loaded, too.
  pages.length = 0;
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(pages).toHaveLength(3);
  act(() => release());
  await view.unmount();
});

it("starts a next page a few rows early and merges the repeats", async () => {
  const { pages } = chatList(SIDEBAR_SESSION_PAGE * 2 + 4);
  const view = mountSessions({ section: { id: "chats", type: "chats" } });
  await view.mount();
  const collection = view.state.current?.collection;
  if (!collection) throw new Error("Missing session store");
  let release = () => {};
  await act(async () => {
    release = collection.acquire();
  });
  await vi.waitFor(() =>
    expect(collection.getBranch(null).ids).toHaveLength(SIDEBAR_SESSION_PAGE),
  );
  expect(pages[0]?.searchParams.get("limit")).toBe(
    String(SIDEBAR_SESSION_PAGE),
  );
  await act(async () => {
    await collection.load({ more: true });
  });
  expect(pages.at(-1)?.searchParams.get("offset")).toBe(
    String(SIDEBAR_SESSION_PAGE - 3),
  );
  // Three rows read again, merged: the next page adds the rest.
  const ids = collection.getBranch(null).ids;
  expect(ids).toHaveLength(SIDEBAR_SESSION_PAGE * 2 - 3);
  expect(new Set(ids).size).toBe(ids.length);
  expect(collection.getBranch(null).cursor).toBe(
    String(SIDEBAR_SESSION_PAGE * 2 - 3),
  );
  act(() => release());
  await view.unmount();
});

it("loads pages until the open chat is in the list", async () => {
  const { pages } = chatList(12);
  const view = mountSessions({
    section: {
      id: "reveal",
      type: "chats",
      source: { type: "chats", pageSize: 3 },
    },
    activeSessionId: "c7",
  });
  await view.mount();
  const collection = view.state.current?.collection;
  if (!collection) throw new Error("Missing session store");
  let release = () => {};
  await act(async () => {
    release = collection.acquire();
  });
  await vi.waitFor(() =>
    expect(collection.getBranch(null).ids).toContain("c7"),
  );
  await act(async () => {});
  expect(collection.getBranch(null).ids).toHaveLength(9);
  expect(
    pages.map((url) => url.searchParams.get("offset")).filter(Boolean),
  ).toEqual(["0", "3", "6"]);
  act(() => release());
  await view.unmount();
});

it("stops looking once the loaded chats are older than the open one", async () => {
  const { pages, reads } = chatList(12);
  const view = mountSessions({
    section: {
      id: "elsewhere",
      type: "chats",
      source: { type: "chats", pageSize: 3 },
    },
    // Not in this list: made between c4 and c5.
    activeSessionId: "elsewhere",
  });
  await view.mount();
  const collection = view.state.current?.collection;
  if (!collection) throw new Error("Missing session store");
  let release = () => {};
  await act(async () => {
    release = collection.acquire();
  });
  await vi.waitFor(() => expect(reads).toEqual(["elsewhere"]));
  await vi.waitFor(() =>
    expect(collection.getBranch(null).ids).toHaveLength(6),
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(collection.getBranch(null).ids).toHaveLength(6);
  expect(pages).toHaveLength(2);
  act(() => release());
  await view.unmount();
});
