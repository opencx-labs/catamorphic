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
  /**
   * The loaded rows are being read (first load or refresh) without
   * discarding the current snapshot. A next page is `paging` instead, shown
   * at the branch's end rather than as a refresh.
   */
  fetching?: boolean;
  /** Rows exist past the loaded ones; `load({ more: true })` reads them. */
  cursor?: string;
  error?: string;
  /** The next page is being read, or waits for a refresh in flight. */
  paging?: boolean;
  /**
   * The last next-page read failed. The loaded rows stay ready; reading the
   * next page again clears it.
   */
  pageError?: string;
}
/**
 * How much of a branch a refresh reads again. `loaded` reads every loaded
 * page (as many reads as built them, and one more). `first` reads from the
 * start only until its rows meet the rows already loaded, keeping the rest:
 * a cheap poll for sources whose new rows arrive at the start (newest
 * first), at any loaded depth. Rows past the meeting point are not read
 * again, so pair it with a periodic `loaded` refresh. It needs pages in one
 * stable order: filter in the source, sort in the view.
 */
export type CollectionRefresh = "first" | "loaded";
export type CollectionChange<T> =
  | { type: "upsert"; items: readonly T[] }
  | { type: "remove"; ids: readonly string[] }
  | {
      type: "invalidate";
      parentId?: string | null;
      /** Defaults to `loaded`. */
      pages?: CollectionRefresh;
    };

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
}: {
  source: CollectionSource<T>;
}) {
  const items = new Map<string, T>();
  const branches = new Map<string | null, CollectionBranch>();
  const itemListeners = new Map<string, Set<Listener>>();
  const listeners = new Set<Listener>();
  const snapshotListeners = new Set<Listener>();
  const branchReferences = new Map<string | null, number>();
  let previewReferences = 0;
  const retainedCounts = new Map<string | null, number>();
  /** How many reads built a branch's loaded depth; a refresh reads no more. */
  const retainedReads = new Map<string | null, number>();
  const requests = new Map<string | null, AbortController>();
  /** Callers of a refresh queued behind IO, answered once it lands. */
  const waiting = new Map<string | null, Array<() => void>>();
  /** Next pages asked for while a refresh of the branch was in flight. */
  const wantMore = new Set<string | null>();
  const dirty = new Set<string>();
  let structural = false;
  let scheduled = false;
  let references = 0;
  let unsubscribe: (() => void) | undefined;
  let revision = 0;
  let snapshotRevision = 0;
  let mutation = 0;
  const changedAt = new Map<string, number>();
  const invalidated = new Map<string | null, CollectionRefresh>();

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
      if (changed || ids.length) {
        snapshotRevision += 1;
        for (const listener of snapshotListeners) listener();
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
      previous.fetching === next.fetching &&
      previous.cursor === next.cursor &&
      previous.error === next.error &&
      previous.paging === next.paging &&
      previous.pageError === next.pageError &&
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
      structure: before?.hasChildren !== item.hasChildren,
    });
  };

  /** The position in `ids` of the last loaded row it already holds. */
  const meeting = (loaded: readonly T[], ids: readonly string[]) => {
    const positions = new Map(ids.map((id, index) => [id, index]));
    for (let index = loaded.length - 1; index >= 0; index -= 1) {
      const position = positions.get(loaded[index]?.id ?? "");
      if (position !== undefined) return position;
    }
    return -1;
  };
  const load = async ({
    parentId = null,
    more = false,
    pages = "loaded",
  }: {
    parentId?: string | null;
    /** Read the page after the loaded rows. */
    more?: boolean;
    /** What a refresh reads again (ignored with `more`). */
    pages?: CollectionRefresh;
  } = {}) => {
    const before = branch(parentId);
    if (more && !before.cursor) {
      if (before.paging) setBranch(parentId, { ...before, paging: undefined });
      return;
    }
    if (requests.has(parentId)) {
      if (more) {
        // The next page follows a refresh in flight instead of being lost.
        if (!before.paging) {
          wantMore.add(parentId);
          setBranch(parentId, {
            ...before,
            paging: true,
            pageError: undefined,
          });
        }
        return;
      }
      // So does a refresh (a Refresh press during a poll): the widest one
      // asked for runs once the IO settles, and the caller waits for it.
      if (invalidated.get(parentId) !== "loaded")
        invalidated.set(parentId, pages);
      return new Promise<void>((resolve) => {
        waiting.set(parentId, [...(waiting.get(parentId) ?? []), resolve]);
      });
    }
    const preview =
      parentId === null &&
      previewReferences > 0 &&
      branchReferences.get(null) === previewReferences;
    const retainedCount = preview
      ? 0
      : Math.max(retainedCounts.get(parentId) ?? 0, before.ids.length);
    // A refresh reads as deep as the loaded rows went, never further: a
    // source that filters (or rows that stopped matching) cannot turn it
    // into a read of the whole history.
    const readLimit = Math.max(1, retainedReads.get(parentId) ?? 0) + 1;
    const startedAt = mutation;
    const controller = new AbortController();
    requests.set(parentId, controller);
    setBranch(
      parentId,
      more
        ? { ...before, paging: true, pageError: undefined }
        : {
            ...before,
            fetching: true,
            status: before.status === "idle" ? "loading" : before.status,
            error: undefined,
          },
    );
    try {
      const loaded: T[] = [];
      const pageIds = new Set<string>();
      let cursor = more ? before.cursor : undefined;
      const seenCursors = new Set<string>(cursor ? [cursor] : []);
      let met = false;
      let reads = 0;
      do {
        reads += 1;
        const part = await source.load({
          parentId,
          cursor,
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        const partIds = new Set<string>();
        for (const item of part.items) {
          if (!item.id || item.id === parentId || partIds.has(item.id))
            throw new Error(
              "Collection pages require unique IDs and cannot contain their parent.",
            );
          partIds.add(item.id);
        }
        // Offset pages repeat a row that moved across their boundary while
        // they were read (or that a source re-reads on purpose): the first
        // read of it wins.
        for (const item of part.items) {
          if (pageIds.has(item.id)) continue;
          pageIds.add(item.id);
          loaded.push(item);
        }
        cursor = part.cursor;
        if (cursor && seenCursors.has(cursor))
          throw new Error("Collection source repeated a cursor");
        if (cursor) seenCursors.add(cursor);
        // A first-page refresh stops where its rows meet the loaded ones.
        met =
          !more &&
          pages === "first" &&
          Boolean(cursor) &&
          loaded.length < retainedCount &&
          meeting(loaded, branch(parentId).ids) >= 0;
      } while (
        !met &&
        !more &&
        cursor &&
        loaded.length < retainedCount &&
        reads < readLimit
      );
      const page = { items: loaded, cursor };
      if (controller.signal.aborted || requests.get(parentId) !== controller)
        return;
      for (const item of page.items) {
        if ((changedAt.get(item.id) ?? 0) <= startedAt) put(item);
      }
      // Push updates received during IO win over an older page snapshot.
      const current = branch(parentId);
      // Rows past the meeting point stay as loaded, with their cursor.
      const kept = met
        ? current.ids.slice(meeting(page.items, current.ids) + 1)
        : [];
      const ids = [
        ...new Set([
          ...(more ? current.ids : []),
          ...[...pageIds].filter(
            (id) =>
              (changedAt.get(id) ?? 0) <= startedAt ||
              (items.has(id) && (items.get(id)?.parentId ?? null) === parentId),
          ),
          ...kept,
          ...current.ids.filter((id) => (changedAt.get(id) ?? 0) > startedAt),
        ]),
      ];
      const nextCursor = met ? current.cursor : page.cursor;
      if (!preview) {
        retainedCounts.set(parentId, ids.length);
        const built = retainedReads.get(parentId) ?? 0;
        retainedReads.set(
          parentId,
          more ? built + reads : met ? Math.max(built, reads) : reads,
        );
      }
      setBranch(parentId, {
        ids,
        status: "ready",
        cursor: nextCursor,
        // A refresh keeps a waiting next page and a failed one's Retry.
        ...(!more && wantMore.has(parentId) ? { paging: true } : {}),
        ...(!more && nextCursor && current.pageError
          ? { pageError: current.pageError }
          : {}),
      });
    } catch (cause) {
      if (!controller.signal.aborted) {
        const message = cause instanceof Error ? cause.message : String(cause);
        // A failed next page leaves the loaded rows ready with a Retry.
        setBranch(
          parentId,
          more
            ? {
                ...branch(parentId),
                paging: undefined,
                pageError: message,
              }
            : {
                ...branch(parentId),
                status: "error",
                fetching: false,
                error: message,
              },
        );
      }
    } finally {
      if (requests.get(parentId) === controller) {
        requests.delete(parentId);
        settle(parentId);
      }
    }
  };
  /**
   * Runs what was asked for while a branch's IO was in flight: the next
   * page first (its own IO settles the rest), then the widest refresh,
   * answering everyone waiting on it.
   */
  const settle = (parentId: string | null) => {
    if (wantMore.delete(parentId)) {
      const current = branch(parentId);
      if (current.cursor) {
        void load({ parentId, more: true });
        return;
      }
      // The refresh found no rows past the loaded ones.
      if (current.paging)
        setBranch(parentId, { ...current, paging: undefined });
    }
    const pending = invalidated.get(parentId);
    const waiters = waiting.get(parentId) ?? [];
    invalidated.delete(parentId);
    waiting.delete(parentId);
    const answer = () => {
      for (const resolve of waiters) resolve();
    };
    if (pending && (branchReferences.has(parentId) || waiters.length))
      void load({ parentId, pages: pending }).finally(answer);
    else answer();
  };
  const abort = (parentId: string | null) => {
    requests.get(parentId)?.abort();
    requests.delete(parentId);
    wantMore.delete(parentId);
    for (const resolve of waiting.get(parentId) ?? []) resolve();
    waiting.delete(parentId);
    const current = branch(parentId);
    if (current.fetching || current.paging)
      setBranch(parentId, {
        ...current,
        fetching: false,
        paging: undefined,
      });
  };
  const publish = (change: CollectionChange<T>) => {
    if (change.type === "invalidate") {
      const parentId = change.parentId ?? null;
      const pages = change.pages ?? "loaded";
      if (requests.has(parentId)) {
        // Coalesced: the widest refresh asked for runs once the IO settles.
        if (invalidated.get(parentId) !== "loaded")
          invalidated.set(parentId, pages);
        return;
      }
      if (branchReferences.has(parentId)) void load({ parentId, pages });
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
        retainedCounts.delete(id);
        retainedReads.delete(id);
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
    getSnapshotRevision: () => snapshotRevision,
    subscribeSnapshot: (listener: Listener) => {
      snapshotListeners.add(listener);
      return () => {
        snapshotListeners.delete(listener);
      };
    },
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
    acquire: ({
      parentId = null,
      mode = "full",
    }: {
      parentId?: string | null;
      mode?: "full" | "preview";
    } = {}) => {
      if (mode === "preview" && parentId !== null)
        throw new Error("Preview leases only acquire the root page");
      const wasPreview =
        parentId === null &&
        previewReferences > 0 &&
        branchReferences.get(null) === previewReferences;
      if (mode === "preview") previewReferences += 1;
      references += 1;
      if (references === 1) {
        unsubscribe = source.subscribe?.(publish);
      }
      const owners = branchReferences.get(parentId) ?? 0;
      branchReferences.set(parentId, owners + 1);
      if (!owners || (wasPreview && mode === "full")) {
        abort(parentId);
        void load({ parentId });
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        references -= 1;
        if (mode === "preview") previewReferences -= 1;
        const owners = (branchReferences.get(parentId) ?? 1) - 1;
        if (owners) {
          branchReferences.set(parentId, owners);
          if (
            parentId === null &&
            mode === "full" &&
            owners === previewReferences
          ) {
            abort(parentId);
            void load({ parentId });
          }
        } else {
          branchReferences.delete(parentId);
          invalidated.delete(parentId);
          if (requests.has(parentId)) {
            abort(parentId);
            const current = branch(parentId);
            setBranch(parentId, {
              ...current,
              status: current.ids.length ? "ready" : "idle",
            });
          }
        }
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
