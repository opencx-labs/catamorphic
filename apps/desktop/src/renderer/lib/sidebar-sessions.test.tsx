// @vitest-environment jsdom
import { createApiClient } from "@catamorphic/api-client";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import {
  readSidebarSessionPage,
  subscribeSidebarSessions,
} from "./sidebar-sessions.js";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  hints: new Set<() => void>(),
}));
const apiClient = createApiClient({
  baseUrl: "http://sidebar.test",
  fetch: mocks.fetch,
});
vi.mock("@catamorphic/react", () => ({
  useCatamorphic: () => ({ apiClient }),
}));
vi.mock("./desktop-api.js", () => ({
  desktopApi: {
    onSessionsChanged: (listener: () => void) => {
      mocks.hints.add(listener);
      return () => mocks.hints.delete(listener);
    },
  },
}));
afterEach(() => {
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

it("reads the lists again when they are invalidated, not when one chat's snapshot is", async () => {
  const client = new QueryClient();
  const listener = vi.fn();
  const stop = subscribeSidebarSessions({
    client,
    projectId: "project",
    listener,
  });
  try {
    // A chat's stream handing over reads its snapshot again.
    client.setQueryData(
      ["cat", "project", "project", "agent", "session", "s1"],
      {},
    );
    await client.invalidateQueries({
      queryKey: ["cat", "project", "project", "agent", "session", "s1"],
    });
    expect(listener).not.toHaveBeenCalled();
    // Archiving a chat invalidates the lists.
    client.setQueryData(["cat", "project", "project", "agent", "sessions"], {});
    await client.invalidateQueries({
      queryKey: ["cat", "project", "project", "agent", "sessions"],
    });
    expect(listener).toHaveBeenCalledWith("loaded", false);
  } finally {
    stop();
    client.clear();
  }
});
