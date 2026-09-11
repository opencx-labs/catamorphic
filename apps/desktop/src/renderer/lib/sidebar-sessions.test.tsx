// @vitest-environment jsdom
import { createApiClient } from "@catamorphic/api-client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import {
  readSidebarSessionPage,
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
