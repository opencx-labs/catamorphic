import { describe, expect, it, vi } from "vitest";
import {
  type CollectionChange,
  type CollectionPage,
  createCollection,
  flattenCollection,
} from "../collection.js";
import { shareEvent } from "../events.js";

interface Item {
  id: string;
  parentId?: string | null;
  label: string;
  hasChildren?: boolean;
}
const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve));

describe("shared collections", () => {
  it("shares listening and batches item-only updates without rebuilding topology", async () => {
    let publish: ((change: CollectionChange<Item>) => void) | undefined;
    const disconnect = vi.fn();
    const connect = vi.fn((listener) => {
      publish = listener;
      return disconnect;
    });
    const collection = createCollection<Item>({
      source: {
        load: async () => ({
          items: [
            { id: "a", label: "A" },
            { id: "b", label: "B" },
          ],
        }),
        subscribe: connect,
      },
    });
    const releaseA = collection.acquire();
    const releaseB = collection.acquire();
    await flush();
    await flush();
    expect(connect).toHaveBeenCalledTimes(1);
    const structure = vi.fn();
    const a = vi.fn();
    const b = vi.fn();
    collection.subscribe(structure);
    collection.subscribeItem("a", a);
    collection.subscribeItem("b", b);
    publish?.({ type: "upsert", items: [{ id: "a", label: "First" }] });
    publish?.({ type: "upsert", items: [{ id: "a", label: "Final" }] });
    await flush();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();
    expect(structure).not.toHaveBeenCalled();
    expect(collection.getItem("a")?.label).toBe("Final");
    releaseA();
    expect(disconnect).not.toHaveBeenCalled();
    releaseB();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("loads roots and children independently and retains loaded pages on refresh", async () => {
    const load = vi.fn(async ({ parentId, cursor }) =>
      parentId
        ? { items: [{ id: "child", parentId, label: "Child" }] }
        : cursor
          ? { items: [{ id: "b", label: "B" }] }
          : {
              items: [{ id: "a", label: "A", hasChildren: true }],
              cursor: "page2",
            },
    );
    const collection = createCollection<Item>({ source: { load } });
    await collection.load();
    expect(load).toHaveBeenCalledTimes(1);
    await collection.load({ more: true });
    await collection.load({ parentId: "a" });
    expect(
      flattenCollection({ collection, expanded: new Set() }).map(
        (row) => row.id,
      ),
    ).toEqual(["a", "b"]);
    expect(
      flattenCollection({ collection, expanded: new Set(["a"]) }).map(
        (row) => row.id,
      ),
    ).toEqual(["a", "child", "b"]);
    await collection.load();
    expect(collection.getBranch(null).ids).toEqual(["a", "b"]);
    collection.publish({ type: "remove", ids: ["a"] });
    expect(collection.getItem("child")).toBeUndefined();
  });

  it("aborts released IO and ignores a late response after a different acquisition", async () => {
    const pending: {
      signal: AbortSignal;
      resolve: (page: CollectionPage<Item>) => void;
    }[] = [];
    const collection = createCollection<Item>({
      source: {
        load: ({ signal }) =>
          new Promise((resolve) => pending.push({ signal, resolve })),
      },
    });
    const first = collection.acquire();
    first();
    const second = collection.acquire();
    expect(pending[0]?.signal.aborted).toBe(true);
    pending[1]?.resolve({ items: [{ id: "new", label: "New" }] });
    await flush();
    pending[0]?.resolve({ items: [{ id: "old", label: "Old" }] });
    await flush();
    expect(collection.getBranch(null).ids).toEqual(["new"]);
    second();
  });

  it("retains push patches and tombstones when an older page resolves", async () => {
    let resolve: ((page: CollectionPage<Item>) => void) | undefined;
    const collection = createCollection<Item>({
      source: {
        load: () =>
          new Promise((done) => {
            resolve = done;
          }),
      },
    });
    const pending = collection.load();
    collection.publish({
      type: "upsert",
      items: [
        { id: "a", label: "Newer" },
        { id: "b", label: "Remove" },
      ],
    });
    collection.publish({ type: "remove", ids: ["b"] });
    resolve?.({
      items: [
        { id: "a", label: "Old" },
        { id: "b", label: "Old" },
      ],
    });
    await pending;
    expect(collection.getItem("a")?.label).toBe("Newer");
    expect(collection.getItem("b")).toBeUndefined();
    expect(collection.getBranch(null).ids).toEqual(["a"]);
  });

  it("coalesces invalidation while IO is pending without starving the request", async () => {
    const pending: Array<(page: CollectionPage<Item>) => void> = [];
    const collection = createCollection<Item>({
      source: { load: () => new Promise((resolve) => pending.push(resolve)) },
    });
    const release = collection.acquire();
    for (let count = 0; count < 20; count += 1)
      collection.publish({ type: "invalidate" });
    expect(pending).toHaveLength(1);
    pending[0]?.({ items: [{ id: "a", label: "First" }] });
    await flush();
    expect(collection.getBranch(null).ids).toEqual(["a"]);
    expect(pending).toHaveLength(2);
    pending[1]?.({ items: [{ id: "a", label: "Caught up" }] });
    await flush();
    expect(collection.getItem("a")?.label).toBe("Caught up");
    release();
  });

  it("preserves live additions and removals when a refresh fails", async () => {
    let reject: ((error: Error) => void) | undefined;
    const collection = createCollection<Item>({
      source: {
        load: () =>
          new Promise((_, fail) => {
            reject = fail;
          }),
      },
    });
    collection.publish({
      type: "upsert",
      items: [{ id: "old", label: "Old" }],
    });
    const pending = collection.load();
    collection.publish({ type: "remove", ids: ["old"] });
    collection.publish({
      type: "upsert",
      items: [{ id: "new", label: "New" }],
    });
    reject?.(new Error("Offline"));
    await pending;
    expect(collection.getBranch(null)).toMatchObject({
      ids: ["new"],
      status: "error",
      error: "Offline",
    });
    expect(collection.getItem("old")).toBeUndefined();
  });

  it("rejects a load-more response that repeats its input cursor", async () => {
    const collection = createCollection<Item>({
      source: {
        load: async ({ cursor }) => ({
          items: [{ id: cursor ? "second" : "first", label: "Row" }],
          cursor: "next",
        }),
      },
    });
    await collection.load();
    await collection.load({ more: true });
    // A failed next page leaves the loaded rows ready, with its error.
    expect(collection.getBranch(null)).toMatchObject({
      ids: ["first"],
      status: "ready",
      cursor: "next",
      pageError: "Collection source repeated a cursor",
    });
    expect(collection.getBranch(null).paging).toBeUndefined();
    expect(collection.getItem("second")).toBeUndefined();
  });

  it("keeps errors separate from empty content and allows retry", async () => {
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error("Offline"))
      .mockResolvedValue({ items: [] });
    const collection = createCollection<Item>({ source: { load } });
    await collection.load();
    expect(collection.getBranch(null)).toMatchObject({
      status: "error",
      error: "Offline",
    });
    await collection.load();
    expect(collection.getBranch(null)).toEqual({
      status: "ready",
      ids: [],
      cursor: undefined,
    });
  });

  it("rejects duplicate IDs atomically and bounds cyclic traversal", async () => {
    const collection = createCollection<Item>({
      source: {
        load: async () => ({
          items: [
            { id: "a", label: "A" },
            { id: "a", label: "Duplicate" },
          ],
        }),
      },
    });
    await collection.load();
    expect(collection.getBranch(null).status).toBe("error");
    expect(collection.getItem("a")).toBeUndefined();
    collection.publish({
      type: "upsert",
      items: [
        { id: "a", label: "A" },
        { id: "b", parentId: "a", label: "B" },
      ],
    });
    collection.publish({
      type: "upsert",
      items: [{ id: "a", parentId: "b", label: "A" }],
    });
    expect(
      flattenCollection({ collection, expanded: new Set(["a", "b"]) }),
    ).toEqual([]);
  });

  it("shares native event attachment and releases it after the last listener", () => {
    let emit: ((value: number) => void) | undefined;
    const stop = vi.fn();
    const connect = vi.fn((listener) => {
      emit = listener;
      return stop;
    });
    const subscribe = shareEvent<number>(connect);
    const a = vi.fn();
    const b = vi.fn();
    const offA = subscribe(a);
    const offB = subscribe(b);
    emit?.(3);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(a).toHaveBeenCalledWith(3);
    expect(b).toHaveBeenCalledWith(3);
    offA();
    expect(stop).not.toHaveBeenCalled();
    offB();
    expect(stop).toHaveBeenCalledTimes(1);
  });
});

it("refreshes only acquired branches and shares child ownership across trees", async () => {
  const pending: { parentId: string | null; signal: AbortSignal }[] = [];
  const collection = createCollection<Item>({
    source: {
      load: ({ parentId, signal }) => {
        pending.push({ parentId, signal });
        return parentId
          ? new Promise(() => {})
          : Promise.resolve({ items: [] });
      },
    },
  });
  const root = collection.acquire();
  const first = collection.acquire({ parentId: "child" });
  const second = collection.acquire({ parentId: "child" });
  expect(
    pending.filter((request) => request.parentId === "child"),
  ).toHaveLength(1);
  first();
  expect(pending[1]?.signal.aborted).toBe(false);
  second();
  expect(pending[1]?.signal.aborted).toBe(true);
  collection.publish({ type: "invalidate", parentId: "child" });
  expect(pending).toHaveLength(2);
  const resume = collection.acquire({ parentId: "child" });
  expect(pending).toHaveLength(3);
  resume();
  root();
});

it("uses one content snapshot for preview and full owners, retaining loaded depth", async () => {
  let empty = false;
  const load = vi.fn(async ({ cursor }) =>
    empty
      ? { items: [] }
      : cursor
        ? { items: [{ id: "second", label: "Second" }] }
        : { items: [{ id: "first", label: "First" }], cursor: "next" },
  );
  const collection = createCollection<Item>({ source: { load } });
  const visible = collection.acquire();
  await flush();
  await collection.load({ more: true });
  expect(collection.getBranch(null).ids).toEqual(["first", "second"]);
  visible();
  const preview = collection.acquire({ mode: "preview" });
  await flush();
  expect(collection.getBranch(null).ids).toEqual(["first"]);
  expect(collection.getItem("second")).toBeDefined();
  const calls = load.mock.calls.length;
  await collection.load();
  expect(load).toHaveBeenCalledTimes(calls + 1);
  // Promoting an existing preview lease restores the full previously loaded depth.
  const restored = collection.acquire();
  await flush();
  await flush();
  expect(collection.getBranch(null).ids).toEqual(["first", "second"]);
  preview();
  empty = true;
  await collection.load();
  expect(collection.getBranch(null)).toMatchObject({
    status: "ready",
    ids: [],
  });
  restored();
  const emptyPreview = collection.acquire({ mode: "preview" });
  // An empty ready snapshot never becomes loading just because it refreshes.
  expect(collection.getBranch(null)).toMatchObject({
    status: "ready",
    ids: [],
  });
  await flush();
  emptyPreview();
});

it("exposes initial and background IO activity while preserving the ready snapshot", async () => {
  let finish: (value: { items: Item[] }) => void = () => {};
  const collection = createCollection<Item>({
    source: {
      load: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    },
  });
  const first = collection.load();
  expect(collection.getBranch(null)).toMatchObject({
    status: "loading",
    fetching: true,
    ids: [],
  });
  finish({ items: [{ id: "one", label: "First" }] });
  await first;
  const refresh = collection.load();
  expect(collection.getBranch(null)).toMatchObject({
    status: "ready",
    fetching: true,
    ids: ["one"],
  });
  expect(collection.getItem("one")?.label).toBe("First");
  finish({ items: [{ id: "one", label: "Updated" }] });
  await refresh;
  expect(collection.getBranch(null).fetching).toBeFalsy();
  expect(collection.getItem("one")?.label).toBe("Updated");
});

describe("paged branches", () => {
  /** An offset-paged, newest-first list whose rows a test can change. */
  const offsetSource = (rows: string[], size: number) => {
    const load = vi.fn(async ({ cursor }: { cursor?: string }) => {
      const offset = cursor ? Number(cursor) : 0;
      const next = offset + size;
      return {
        items: rows
          .slice(offset, next)
          .map((id) => ({ id, label: id.toUpperCase() })),
        cursor: next < rows.length ? String(next) : undefined,
      };
    });
    return load;
  };

  it("keeps the loaded rows ready when a next page fails, and retries it", async () => {
    let fail = true;
    const collection = createCollection<Item>({
      source: {
        load: async ({ cursor }) => {
          if (cursor && fail) throw new Error("Offline");
          return cursor
            ? { items: [{ id: "b", label: "B" }] }
            : { items: [{ id: "a", label: "A" }], cursor: "1" };
        },
      },
    });
    await collection.load();
    const paging = collection.load({ more: true });
    expect(collection.getBranch(null)).toMatchObject({
      status: "ready",
      paging: true,
    });
    await paging;
    expect(collection.getBranch(null)).toMatchObject({
      ids: ["a"],
      status: "ready",
      cursor: "1",
      pageError: "Offline",
    });
    expect(collection.getBranch(null).error).toBeUndefined();
    // A refresh keeps the failed page's Retry.
    await collection.load();
    expect(collection.getBranch(null).pageError).toBe("Offline");
    fail = false;
    await collection.load({ more: true });
    expect(collection.getBranch(null)).toEqual({
      ids: ["a", "b"],
      status: "ready",
      cursor: undefined,
    });
  });

  it("reads a next page asked for during a refresh once the refresh lands", async () => {
    const pending: Array<{
      cursor?: string;
      resolve: (page: CollectionPage<Item>) => void;
    }> = [];
    const collection = createCollection<Item>({
      source: {
        load: ({ cursor }) =>
          new Promise((resolve) => pending.push({ cursor, resolve })),
      },
    });
    const first = collection.load();
    pending[0]?.resolve({ items: [{ id: "a", label: "A" }], cursor: "1" });
    await first;
    const refresh = collection.load();
    void collection.load({ more: true });
    // Not lost and not doubled: it waits, and says so.
    void collection.load({ more: true });
    expect(collection.getBranch(null).paging).toBe(true);
    expect(pending).toHaveLength(2);
    pending[1]?.resolve({ items: [{ id: "a", label: "A" }], cursor: "1" });
    await refresh;
    expect(pending).toHaveLength(3);
    expect(pending[2]?.cursor).toBe("1");
    expect(collection.getBranch(null).paging).toBe(true);
    pending[2]?.resolve({ items: [{ id: "b", label: "B" }] });
    await vi.waitFor(() =>
      expect(collection.getBranch(null).ids).toEqual(["a", "b"]),
    );
    expect(collection.getBranch(null).paging).toBeUndefined();
  });

  it("refreshes a deep list from its first page and keeps the rest", async () => {
    const rows = ["a", "b", "c", "d", "e", "f", "g"];
    const load = offsetSource(rows, 3);
    const collection = createCollection<Item>({ source: { load } });
    const release = collection.acquire();
    await flush();
    await collection.load({ more: true });
    expect(collection.getBranch(null)).toMatchObject({
      ids: ["a", "b", "c", "d", "e", "f"],
      cursor: "6",
    });
    // A new row arrives first and one on the first page goes away.
    rows.splice(0, 2, "new", "a");
    load.mockClear();
    collection.publish({ type: "invalidate", pages: "first" });
    await vi.waitFor(() =>
      expect(collection.getBranch(null).fetching).toBeFalsy(),
    );
    expect(load).toHaveBeenCalledTimes(1);
    expect(load.mock.calls[0]?.[0].cursor).toBeUndefined();
    expect(collection.getBranch(null)).toMatchObject({
      ids: ["new", "a", "c", "d", "e", "f"],
      cursor: "6",
      status: "ready",
    });
    expect(collection.getItem("new")?.label).toBe("NEW");
    // Every loaded page is still read by an ordinary invalidation.
    load.mockClear();
    collection.publish({ type: "invalidate" });
    await vi.waitFor(() =>
      expect(collection.getBranch(null).fetching).toBeFalsy(),
    );
    expect(load).toHaveBeenCalledTimes(2);
    expect(collection.getBranch(null)).toMatchObject({
      ids: ["new", "a", "c", "d", "e", "f"],
      cursor: "6",
    });
    release();
  });

  it("reads further when the first page no longer meets the loaded rows", async () => {
    const rows = ["a", "b", "c", "d"];
    const load = offsetSource(rows, 2);
    const collection = createCollection<Item>({ source: { load } });
    const release = collection.acquire();
    await flush();
    await collection.load({ more: true });
    // A whole page of new rows: nothing to stitch to on the first page.
    rows.unshift("n1", "n2");
    load.mockClear();
    collection.publish({ type: "invalidate", pages: "first" });
    await vi.waitFor(() =>
      expect(collection.getBranch(null).fetching).toBeFalsy(),
    );
    expect(load.mock.calls.map(([request]) => request.cursor)).toEqual([
      undefined,
      "2",
    ]);
    expect(collection.getBranch(null)).toMatchObject({
      ids: ["n1", "n2", "a", "b"],
      cursor: "4",
    });
    release();
  });

  it("merges a row repeated across the pages of one refresh", async () => {
    const collection = createCollection<Item>({
      source: {
        load: async ({ cursor }) =>
          cursor
            ? {
                items: [
                  { id: "b", label: "B again" },
                  { id: "c", label: "C" },
                ],
              }
            : {
                items: [
                  { id: "a", label: "A" },
                  { id: "b", label: "B" },
                ],
                cursor: "1",
              },
      },
    });
    await collection.load();
    await collection.load({ more: true });
    await collection.load();
    expect(collection.getBranch(null)).toMatchObject({
      ids: ["a", "b", "c"],
      status: "ready",
    });
    expect(collection.getItem("b")?.label).toBe("B");
  });

  it("runs the widest refresh asked for while one is in flight", async () => {
    const pending: Array<(page: CollectionPage<Item>) => void> = [];
    const cursors: Array<string | undefined> = [];
    const collection = createCollection<Item>({
      source: {
        load: ({ cursor }) => {
          cursors.push(cursor);
          return new Promise((resolve) => pending.push(resolve));
        },
      },
    });
    const release = collection.acquire();
    pending[0]?.({ items: [{ id: "a", label: "A" }], cursor: "1" });
    await flush();
    void collection.load({ more: true });
    pending[1]?.({ items: [{ id: "b", label: "B" }], cursor: "2" });
    await flush();
    void collection.load();
    collection.publish({ type: "invalidate", pages: "first" });
    collection.publish({ type: "invalidate" });
    collection.publish({ type: "invalidate", pages: "first" });
    pending[2]?.({ items: [{ id: "a", label: "A" }], cursor: "1" });
    await flush();
    pending[3]?.({ items: [{ id: "b", label: "B" }], cursor: "2" });
    await flush();
    // One more full read (two pages), not a first-page one.
    expect(cursors.slice(4)).toEqual([undefined]);
    pending[4]?.({ items: [{ id: "a", label: "A" }], cursor: "1" });
    await flush();
    expect(cursors.slice(5)).toEqual(["1"]);
    release();
  });
});
