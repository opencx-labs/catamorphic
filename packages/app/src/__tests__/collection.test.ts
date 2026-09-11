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
