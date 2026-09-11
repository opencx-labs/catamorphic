/** Host-neutral collections. No React, transport, credentials or global singleton. */
export interface CollectionItem {
  id: string;
  parentId?: string | null;
  hasChildren?: boolean;
}

export type CollectionStatus = "idle" | "loading" | "ready" | "error";
export interface CollectionPage<T> {
  items: readonly T[];
  cursor?: string;
}
export interface CollectionBranch {
  ids: readonly string[];
  status: CollectionStatus;
  cursor?: string;
  error?: string;
}
export type CollectionChange<T> =
  | { type: "upsert"; items: readonly T[] }
  | { type: "remove"; ids: readonly string[] }
  | { type: "invalidate"; parentId?: string | null };

export interface CollectionSource<T extends CollectionItem> {
  load: (request: {
    parentId: string | null;
    cursor?: string;
    signal: AbortSignal;
  }) => Promise<CollectionPage<T>>;
  /** One subscription per acquired store, shared by all of its consumers. */
  subscribe?: (publish: (change: CollectionChange<T>) => void) => () => void;
}

const EMPTY_BRANCH: CollectionBranch = { ids: [], status: "idle" };
type Listener = () => void;

/**
 * Identity-indexed cache with separate item and structure subscriptions. Owners
 * retain a store per source/scope. acquire() reference-counts upstream listening;
 * release aborts obsolete IO without deleting snapshots or expansion state.
 */
export function createCollection<T extends CollectionItem>({
  source,
  structureKey,
}: {
  source: CollectionSource<T>;
  /** Fields that affect a presentation projection, such as grouping or sorting. */
  structureKey?: (item: T) => unknown;
}) {
  const items = new Map<string, T>();
  const branches = new Map<string | null, CollectionBranch>();
  const itemListeners = new Map<string, Set<Listener>>();
  const listeners = new Set<Listener>();
  const requests = new Map<string | null, AbortController>();
  const dirty = new Set<string>();
  let structural = false;
  let scheduled = false;
  let references = 0;
  let unsubscribe: (() => void) | undefined;
  let revision = 0;
  let mutation = 0;
  const changedAt = new Map<string, number>();
  const invalidated = new Set<string | null>();

  const notify = ({
    id,
    structure = false,
  }: {
    id?: string;
    structure?: boolean;
  }) => {
    if (id) dirty.add(id);
    structural ||= structure;
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      const ids = [...dirty];
      const changed = structural;
      dirty.clear();
      structural = false;
      if (changed) {
        revision += 1;
        for (const listener of listeners) listener();
      }
      for (const id of ids)
        for (const listener of itemListeners.get(id) ?? []) listener();
    });
  };
  const branch = (parentId: string | null) =>
    branches.get(parentId) ?? EMPTY_BRANCH;
  const setBranch = (parentId: string | null, next: CollectionBranch) => {
    const previous = branches.get(parentId);
    if (
      previous &&
      previous.status === next.status &&
      previous.cursor === next.cursor &&
      previous.error === next.error &&
      previous.ids.length === next.ids.length &&
      previous.ids.every((id, index) => id === next.ids[index])
    )
      return;
    branches.set(parentId, next);
    notify({ structure: true });
  };
  const put = (item: T) => {
    if (!item.id) throw new Error("Collection items need stable nonempty IDs.");
    const before = items.get(item.id);
    const previousFields = before ? new Map(Object.entries(before)) : undefined;
    if (
      before &&
      Object.keys(before).length === Object.keys(item).length &&
      Object.entries(item).every(([key, value]) =>
        Object.is(previousFields?.get(key), value),
      )
    )
      return;
    items.set(item.id, item);
    notify({
      id: item.id,
      structure:
        before?.hasChildren !== item.hasChildren ||
        Boolean(
          structureKey &&
            (!before || !Object.is(structureKey(before), structureKey(item))),
        ),
    });
  };

  const load = async ({
    parentId = null,
    more = false,
  }: {
    parentId?: string | null;
    more?: boolean;
  } = {}) => {
    if (requests.has(parentId)) return;
    const before = branch(parentId);
    if (more && !before.cursor) return;
    const startedAt = mutation;
    const controller = new AbortController();
    requests.set(parentId, controller);
    if (!before.ids.length)
      setBranch(parentId, { ...before, status: "loading", error: undefined });
    try {
      const loaded: T[] = [];
      let cursor = more ? before.cursor : undefined;
      const seenCursors = new Set<string>();
      do {
        const part = await source.load({
          parentId,
          cursor,
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        loaded.push(...part.items);
        cursor = part.cursor;
        if (cursor && seenCursors.has(cursor))
          throw new Error("Collection source repeated a cursor");
        if (cursor) seenCursors.add(cursor);
      } while (!more && cursor && loaded.length < before.ids.length);
      const page = { items: loaded, cursor };
      if (controller.signal.aborted || requests.get(parentId) !== controller)
        return;
      const pageIds = new Set<string>();
      for (const item of page.items) {
        if (!item.id || item.id === parentId || pageIds.has(item.id))
          throw new Error(
            "Collection pages require unique IDs and cannot contain their parent.",
          );
        pageIds.add(item.id);
      }
      for (const item of page.items) {
        if ((changedAt.get(item.id) ?? 0) <= startedAt) put(item);
      }
      // Push updates received during IO win over an older page snapshot.
      const current = branch(parentId);
      const ids = [
        ...new Set([
          ...(more ? current.ids : []),
          ...[...pageIds].filter(
            (id) =>
              (changedAt.get(id) ?? 0) <= startedAt ||
              (items.has(id) && (items.get(id)?.parentId ?? null) === parentId),
          ),
          ...current.ids.filter((id) => (changedAt.get(id) ?? 0) > startedAt),
        ]),
      ];
      setBranch(parentId, { ids, status: "ready", cursor: page.cursor });
    } catch (cause) {
      if (!controller.signal.aborted)
        setBranch(parentId, {
          ...before,
          status: "error",
          error: cause instanceof Error ? cause.message : String(cause),
        });
    } finally {
      if (requests.get(parentId) === controller) {
        requests.delete(parentId);
        if (invalidated.delete(parentId) && references) void load({ parentId });
      }
    }
  };
  const abort = (parentId: string | null) => {
    requests.get(parentId)?.abort();
    requests.delete(parentId);
  };
  const publish = (change: CollectionChange<T>) => {
    if (change.type === "invalidate") {
      const parentId = change.parentId ?? null;
      if (requests.has(parentId)) {
        invalidated.add(parentId);
        return;
      }
      if (references) void load({ parentId });
      else setBranch(parentId, { ...branch(parentId), status: "idle" });
      return;
    }
    mutation += 1;
    if (change.type === "remove") {
      const removed = new Set(change.ids);
      // Descendants are removed once, including unloaded-parent/orphan snapshots.
      const children = new Map<string, string[]>();
      for (const item of items.values()) {
        if (!item.parentId) continue;
        const list = children.get(item.parentId) ?? [];
        list.push(item.id);
        children.set(item.parentId, list);
      }
      const queue = [...removed];
      for (let index = 0; index < queue.length; index += 1) {
        for (const id of children.get(queue[index] ?? "") ?? []) {
          if (!removed.has(id)) {
            removed.add(id);
            queue.push(id);
          }
        }
      }
      for (const id of removed) {
        changedAt.set(id, mutation);
        items.delete(id);
        abort(id);
        branches.delete(id);
        notify({ id });
      }
      for (const [parentId, value] of branches) {
        const ids = value.ids.filter((id) => !removed.has(id));
        if (ids.length !== value.ids.length)
          setBranch(parentId, { ...value, ids });
      }
      return;
    }
    for (const item of change.items) {
      changedAt.set(item.id, mutation);
      const before = items.get(item.id);
      const parentId = item.parentId ?? null;
      const previousParent = before?.parentId ?? null;
      if (before && previousParent !== parentId) {
        const previous = branch(previousParent);
        setBranch(previousParent, {
          ...previous,
          ids: previous.ids.filter((id) => id !== item.id),
        });
      }
      put(item);
      const current = branch(parentId);
      if (!current.ids.includes(item.id))
        setBranch(parentId, {
          ...current,
          ids: [...current.ids, item.id],
          status: "ready",
        });
    }
  };
  return {
    getItem: (id: string) => items.get(id),
    getBranch: branch,
    getRevision: () => revision,
    isAcquired: () => references > 0,
    subscribe: (listener: Listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    subscribeItem: (id: string, listener: Listener) => {
      const set = itemListeners.get(id) ?? new Set<Listener>();
      set.add(listener);
      itemListeners.set(id, set);
      return () => {
        set.delete(listener);
        if (!set.size) itemListeners.delete(id);
      };
    },
    acquire: () => {
      references += 1;
      if (references === 1) {
        unsubscribe = source.subscribe?.(publish);
        void load();
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        references -= 1;
        if (references) return;
        unsubscribe?.();
        unsubscribe = undefined;
        invalidated.clear();
        for (const parentId of requests.keys()) {
          abort(parentId);
          const current = branch(parentId);
          setBranch(parentId, {
            ...current,
            status: current.ids.length ? "ready" : "idle",
          });
        }
      };
    },
    load,
    publish,
  };
}

export type Collection<T extends CollectionItem> = ReturnType<
  typeof createCollection<T>
>;

export interface TreeRow {
  id: string;
  parentId: string | null;
  depth: number;
  position: number;
  siblings: number;
}

/** Iterative traversal visits only expanded branches and terminates on bad cycles. */
export function flattenCollection<T extends CollectionItem>({
  collection,
  expanded,
}: {
  collection: Collection<T>;
  expanded: ReadonlySet<string>;
  /** Snapshot version for memoized consumers. */
  revision?: number;
}): TreeRow[] {
  const rows: TreeRow[] = [];
  const seen = new Set<string>();
  const push = (
    ids: readonly string[],
    parentId: string | null,
    depth: number,
  ) =>
    ids
      .map((id, index) => ({
        id,
        parentId,
        depth,
        position: index + 1,
        siblings: ids.length,
      }))
      .reverse();
  const stack = push(collection.getBranch(null).ids, null, 0);
  while (stack.length) {
    const row = stack.pop();
    if (!row || seen.has(row.id)) continue;
    seen.add(row.id);
    rows.push(row);
    if (expanded.has(row.id)) {
      const children = push(
        collection.getBranch(row.id).ids,
        row.id,
        row.depth + 1,
      );
      for (const child of children) stack.push(child);
    }
  }
  return rows;
}
