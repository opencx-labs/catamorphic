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
  useOpenSidebarSession,
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
function chatList(
  count: number,
  extra: Array<{
    id: string;
    title?: string;
    visibility?: string;
    parentSessionId?: string | null;
    /** Its age in chats: 4.5 sits between c4 and c5. */
    age: number;
  }> = [],
) {
  const created = (index: number) =>
    new Date(Date.UTC(2026, 0, 1) - index * 60_000).toISOString();
  const chats = Array.from({ length: count }, (_, index) => ({
    id: `c${index}`,
    title: `Chat ${index}`,
    visibility: "promoted",
    parentSessionId: null as string | null,
    childCount: 0,
    createdAt: created(index),
  }));
  const others = extra.map((chat) => ({
    id: chat.id,
    title: chat.title ?? chat.id,
    visibility: chat.visibility ?? "promoted",
    parentSessionId: chat.parentSessionId ?? null,
    childCount: 0,
    createdAt: created(chat.age),
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
  const state: {
    current?: ReturnType<typeof useSidebarSessions>;
    open?: ReturnType<typeof useOpenSidebarSession>;
  } = {};
  function Probe() {
    const sessions = useSidebarSessions({
      projectId: "paged",
      section,
      visible: true,
      relevant: true,
    });
    state.current = sessions;
    state.open = useOpenSidebarSession({
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
    client,
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

/** Acquire the root as the tree does and read until `rows` are loaded. */
async function loadRows(view: ReturnType<typeof mountSessions>, rows: number) {
  const collection = view.state.current?.collection;
  if (!collection) throw new Error("Missing session store");
  let release = () => {};
  await act(async () => {
    release = collection.acquire();
  });
  await vi.waitFor(() =>
    expect(collection.getBranch(null).status).toBe("ready"),
  );
  while (
    collection.getBranch(null).ids.length < rows &&
    collection.getBranch(null).cursor
  )
    await act(async () => {
      await collection.load({ more: true });
    });
  return { collection, release };
}

it("polls a deep list's first page and reads every loaded page every 30 seconds", async () => {
  vi.useFakeTimers();
  const { pages } = chatList(20);
  const view = mountSessions({
    section: {
      id: "polled",
      type: "chats",
      source: { type: "chats", pageSize: 4 },
    },
  });
  await view.mount();
  // Pages of four start two rows early: 4, then 2 new rows per page.
  const { collection, release } = await loadRows(view, 12);
  expect(collection.getBranch(null).ids).toHaveLength(12);
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
    "2",
    "4",
    "6",
    "8",
  ]);
  expect(collection.getBranch(null).ids).toHaveLength(12);
  // Coming back to the window reads everything loaded, too.
  await vi.waitFor(() =>
    expect(collection.getBranch(null).fetching).toBeFalsy(),
  );
  pages.length = 0;
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(1);
  });
  await vi.waitFor(() =>
    expect(collection.getBranch(null).fetching).toBeFalsy(),
  );
  expect(pages.map((url) => url.searchParams.get("offset"))).toEqual([
    "0",
    "2",
    "4",
    "6",
    "8",
  ]);
  act(() => release());
  await view.unmount();
});

it("reads a short list whole on every poll, so no loaded row lags", async () => {
  vi.useFakeTimers();
  const { pages } = chatList(20);
  const view = mountSessions({
    section: {
      id: "short",
      type: "chats",
      source: { type: "chats", pageSize: 4 },
    },
  });
  await view.mount();
  const { collection, release } = await loadRows(view, 6);
  expect(collection.getBranch(null).ids).toHaveLength(6);
  pages.length = 0;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2_000);
  });
  expect(pages.map((url) => url.searchParams.get("offset"))).toEqual([
    "0",
    "2",
  ]);
  act(() => release());
  await view.unmount();
});

it("keeps every chat when a new one arrives in a sorted section", async () => {
  vi.useFakeTimers();
  const { chats } = chatList(9);
  // Titles that a per-page sort would reorder: c1 and c2 before c0.
  for (const [index, title] of [
    "c",
    "a",
    "b",
    "e",
    "d",
    "f",
    "h",
    "g",
    "i",
  ].entries())
    if (chats[index]) chats[index].title = title;
  const view = mountSessions({
    section: {
      id: "sorted",
      type: "chats",
      source: {
        type: "chats",
        pageSize: 3,
        sort: { field: "title", direction: "asc" },
      },
    },
  });
  await view.mount();
  const { collection, release } = await loadRows(view, 9);
  const before = [...collection.getBranch(null).ids];
  expect(before).toHaveLength(9);
  // Pages keep the server's order; the view sorts.
  expect(before).toEqual(chats.map((chat) => chat.id));
  chats.unshift({
    id: "new",
    title: "z",
    visibility: "promoted",
    parentSessionId: null,
    childCount: 0,
    createdAt: new Date(Date.UTC(2026, 0, 2)).toISOString(),
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2_000);
  });
  expect(collection.getBranch(null).ids).toEqual(["new", ...before]);
  act(() => release());
  await view.unmount();
});

it("starts a next page five rows early and merges the repeats", async () => {
  const { pages } = chatList(SIDEBAR_SESSION_PAGE * 2 + 4);
  const view = mountSessions({ section: { id: "chats", type: "chats" } });
  await view.mount();
  const { collection, release } = await loadRows(view, 1);
  expect(collection.getBranch(null).ids).toHaveLength(SIDEBAR_SESSION_PAGE);
  expect(pages[0]?.searchParams.get("limit")).toBe(
    String(SIDEBAR_SESSION_PAGE),
  );
  await act(async () => {
    await collection.load({ more: true });
  });
  expect(pages.at(-1)?.searchParams.get("offset")).toBe(
    String(SIDEBAR_SESSION_PAGE - 5),
  );
  const ids = collection.getBranch(null).ids;
  expect(ids).toHaveLength(SIDEBAR_SESSION_PAGE * 2 - 5);
  expect(new Set(ids).size).toBe(ids.length);
  expect(collection.getBranch(null).cursor).toBe(
    `${SIDEBAR_SESSION_PAGE * 2 - 5}~c${SIDEBAR_SESSION_PAGE * 2 - 6}`,
  );
  act(() => release());
  await view.unmount();
});

it("starts a page earlier when more chats went away than the overlap covers", async () => {
  const { chats, pages } = chatList(30);
  const view = mountSessions({
    section: {
      id: "archived",
      type: "chats",
      source: { type: "chats", pageSize: 10 },
    },
  });
  await view.mount();
  const { collection, release } = await loadRows(view, 1);
  expect(collection.getBranch(null).ids).toHaveLength(10);
  // Seven chats on the first page are archived elsewhere: every later
  // offset moves up by seven, past the five-row overlap.
  chats.splice(1, 7);
  // As the archive's own refresh does: the cached pages are stale now.
  await view.client.invalidateQueries({ refetchType: "none" });
  pages.length = 0;
  await act(async () => {
    await collection.load({ more: true });
  });
  expect(pages.map((url) => url.searchParams.get("offset"))).toEqual([
    "5",
    "0",
  ]);
  // c10 now sits at offset 3: it is read, not skipped.
  expect(collection.getBranch(null).ids).toContain("c10");
  act(() => release());
  await view.unmount();
});

it("shows an older open chat past the loaded rows without reading up to it", async () => {
  const { pages, reads } = chatList(12);
  const view = mountSessions({
    section: {
      id: "open",
      type: "chats",
      source: { type: "chats", pageSize: 3 },
    },
    activeSessionId: "c7",
  });
  await view.mount();
  const { collection, release } = await loadRows(view, 1);
  await vi.waitFor(() => expect(view.state.open?.id).toBe("c7"));
  expect(view.state.open).toMatchObject({ parentId: null, hasChildren: false });
  expect(reads).toEqual(["c7"]);
  expect(pages).toHaveLength(1);
  expect(collection.getBranch(null).ids).toHaveLength(3);
  act(() => release());
  await view.unmount();
});

it("shows a fork's family row, and nothing for chats the list does not hold", async () => {
  const { reads } = chatList(12, [
    { id: "fork", parentSessionId: "c9", age: 9.5 },
    { id: "gone", visibility: "archived", age: 8.5 },
    { id: "fresh", age: 0.5 },
  ]);
  const shown = async (activeSessionId: string) => {
    const view = mountSessions({
      section: {
        id: `open-${activeSessionId}`,
        type: "chats",
        source: { type: "chats", pageSize: 3 },
      },
      activeSessionId,
    });
    await view.mount();
    const { release } = await loadRows(view, 1);
    await vi.waitFor(() => expect(reads).toContain(activeSessionId));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    const open = view.state.open?.id;
    act(() => release());
    await view.unmount();
    return open;
  };
  expect(await shown("fork")).toBe("c9");
  // Archived: not in this list. Newer than the loaded rows: the next poll.
  expect(await shown("gone")).toBeUndefined();
  expect(await shown("fresh")).toBeUndefined();
});
