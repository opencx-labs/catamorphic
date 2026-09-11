import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  type Collection,
  type CollectionItem,
  flattenCollection,
} from "../collection.js";
import { useAnimatedItems } from "./animated-list.js";
import { CollectionItemView } from "./collection-item.js";

export interface TreeItem {
  id: string;
  parentId?: string | null;
  hasChildren?: boolean;
  collapsed?: boolean;
}
export interface TreeRenderContext {
  depth: number;
  expanded: boolean;
  hasChildren: boolean;
  toggle: () => void;
}

/**
 * One virtual viewport for a whole tree. Source items can be paginated and have
 * unloaded children. Identity, focus and expansion survive reordering and updates.
 * Row height is explicit so custom presentations can choose a larger density.
 */
export function Tree<T extends TreeItem>({
  items: sourceItems,
  label,
  renderItem,
  loadChildren,
  onLoadMore,
  selectedId,
  rowHeight = 28,
  height = 336,
  overscan = 5,
  expanded: controlled,
  onExpandedChange,
  defaultExpanded = true,
  className,
  style,
  motionClasses,
}: {
  items: readonly T[];
  label: string;
  renderItem: (item: T, context: TreeRenderContext) => ReactNode;
  loadChildren?: (id: string) => void;
  onLoadMore?: () => void;
  selectedId?: string;
  rowHeight?: number;
  height?: number;
  overscan?: number;
  expanded?: ReadonlySet<string>;
  onExpandedChange?: (expanded: ReadonlySet<string>) => void;
  defaultExpanded?: boolean;
  className?: string;
  style?: CSSProperties;
  motionClasses?: { enter: string; exit: string };
}) {
  const { entries: animated } = useAnimatedItems({
    items: sourceItems,
    getKey: (item) => item.id,
  });
  const items = useMemo(() => animated.map((entry) => entry.item), [animated]);
  const motion = useMemo(
    () => new Map(animated.map((entry) => [entry.key, entry])),
    [animated],
  );
  const viewport = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [overrides, setOverrides] = useState<ReadonlyMap<string, boolean>>(
    new Map(),
  );
  const [focusedId, setFocusedId] = useState<string>();
  const byId = useMemo(
    () => new Map(items.map((item) => [item.id, item])),
    [items],
  );
  const expanded = useMemo(
    () =>
      controlled ??
      new Set(
        items
          .filter(
            (item) =>
              overrides.get(item.id) ??
              (item.collapsed === undefined
                ? defaultExpanded
                : !item.collapsed),
          )
          .map((item) => item.id),
      ),
    [controlled, items, overrides, defaultExpanded],
  );
  const tree = useMemo(() => {
    const children = new Map<string | null, string[]>();
    for (const item of items) {
      const parentId =
        item.parentId && byId.has(item.parentId) ? item.parentId : null;
      const list = children.get(parentId) ?? [];
      list.push(item.id);
      children.set(parentId, list);
    }
    const rows: {
      id: string;
      parentId: string | null;
      depth: number;
      position: number;
      siblings: number;
    }[] = [];
    const seen = new Set<string>();
    const push = (parentId: string | null, depth: number) =>
      (children.get(parentId) ?? [])
        .map((id, index, siblings) => ({
          id,
          parentId,
          depth,
          position: index + 1,
          siblings: siblings.length,
        }))
        .reverse();
    const stack = push(null, 0);
    while (stack.length) {
      const row = stack.pop();
      if (!row || seen.has(row.id)) continue;
      seen.add(row.id);
      rows.push(row);
      if (expanded.has(row.id))
        for (const child of push(row.id, row.depth + 1)) stack.push(child);
    }
    return {
      rows,
      children,
      indexById: new Map(rows.map((row, index) => [row.id, index])),
    };
  }, [items, byId, expanded]);
  const toggle = (id: string) => {
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id);
    else {
      next.add(id);
      loadChildren?.(id);
    }
    if (controlled) onExpandedChange?.(next);
    else setOverrides((current) => new Map(current).set(id, next.has(id)));
  };
  const actualHeight = Math.min(height, tree.rows.length * rowHeight);
  const reveal = useCallback(
    (id: string) => {
      const index = tree.rows.findIndex((row) => row.id === id);
      const node = viewport.current;
      if (index < 0 || !node) return;
      const top = index * rowHeight;
      if (top < node.scrollTop) node.scrollTop = top;
      else if (top + rowHeight > node.scrollTop + actualHeight)
        node.scrollTop = top + rowHeight - actualHeight;
      setScrollTop(node.scrollTop);
    },
    [tree.rows, rowHeight, actualHeight],
  );
  const previousAnchor = useRef<{ id: string; offset: number } | undefined>(
    undefined,
  );
  useLayoutEffect(() => {
    const anchor = previousAnchor.current;
    const node = viewport.current;
    if (node && anchor) {
      const index = tree.rows.findIndex((row) => row.id === anchor.id);
      if (index >= 0) {
        node.scrollTop = index * rowHeight + anchor.offset;
        setScrollTop(node.scrollTop);
      }
    }
    if (focusedId && !tree.rows.some((row) => row.id === focusedId)) {
      const previous = byId.get(focusedId)?.parentId;
      setFocusedId(
        previous && byId.has(previous) ? previous : tree.rows[0]?.id,
      );
    }
  }, [tree.rows, rowHeight, byId, focusedId]);
  const lastFocused = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    if (!focusedId || focusedId === lastFocused.current) return;
    lastFocused.current = focusedId;
    reveal(focusedId);
    const node = [
      ...(viewport.current?.querySelectorAll<HTMLElement>("[data-tree-id]") ??
        []),
    ].find((entry) => entry.dataset.treeId === focusedId);
    node?.focus({ preventScroll: true });
  }, [focusedId, reveal]);
  useEffect(() => {
    if (!selectedId) return;
    const ancestors = new Set<string>();
    let parentId = byId.get(selectedId)?.parentId;
    while (parentId && !ancestors.has(parentId)) {
      ancestors.add(parentId);
      parentId = byId.get(parentId)?.parentId;
    }
    if ([...ancestors].some((id) => !expanded.has(id))) {
      if (controlled) onExpandedChange?.(new Set([...expanded, ...ancestors]));
      else
        setOverrides(
          (current) =>
            new Map([
              ...current,
              ...[...ancestors].map((id): [string, boolean] => [id, true]),
            ]),
        );
    }
  }, [selectedId, byId, expanded, controlled, onExpandedChange]);
  const revealedSelection = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    if (
      selectedId &&
      selectedId !== revealedSelection.current &&
      tree.rows.some((row) => row.id === selectedId)
    ) {
      reveal(selectedId);
      revealedSelection.current = selectedId;
    }
  }, [selectedId, tree.rows, reveal]);
  const start = Math.max(
    0,
    Math.min(
      Math.floor(scrollTop / rowHeight) - overscan,
      tree.rows.length - 1,
    ),
  );
  const end = Math.min(
    tree.rows.length,
    start + Math.ceil(height / rowHeight) + overscan * 2,
  );
  const retainedIds = new Set(
    [
      ...(viewport.current?.querySelectorAll<HTMLElement>(
        '[data-interacting="true"]',
      ) ?? []),
    ].map(
      (element) =>
        element.closest<HTMLElement>("[data-tree-id]")?.dataset.treeId,
    ),
  );
  return (
    <>
      <div
        ref={viewport}
        role="tree"
        aria-label={label}
        className={className}
        style={{
          overflow: "auto",
          overscrollBehavior: "contain",
          height: actualHeight,
          ...style,
        }}
        onScroll={(event) => {
          const top = event.currentTarget.scrollTop;
          const row = tree.rows[Math.floor(top / rowHeight)];
          previousAnchor.current = row
            ? { id: row.id, offset: top % rowHeight }
            : undefined;
          setScrollTop(top);
        }}
        onKeyDown={(event) => {
          if (
            event.target instanceof HTMLElement &&
            event.target.matches("input,textarea,select,[contenteditable=true]")
          )
            return;
          const element =
            event.target instanceof HTMLElement
              ? event.target.closest<HTMLElement>("[data-tree-id]")
              : null;
          const id = element?.dataset.treeId;
          const index = tree.rows.findIndex((row) => row.id === id);
          const row = tree.rows[index];
          if (!row) return;
          const children = tree.children.get(row.id) ?? [];
          const item = byId.get(row.id);
          let next: string | undefined;
          switch (event.key) {
            case "ArrowDown":
              next = tree.rows[Math.min(tree.rows.length - 1, index + 1)]?.id;
              break;
            case "ArrowUp":
              next = tree.rows[Math.max(0, index - 1)]?.id;
              break;
            case "Home":
              next = tree.rows[0]?.id;
              break;
            case "End":
              next = tree.rows.at(-1)?.id;
              break;
            case "PageDown":
              next =
                tree.rows[
                  Math.min(
                    tree.rows.length - 1,
                    index + Math.ceil(height / rowHeight),
                  )
                ]?.id;
              break;
            case "PageUp":
              next =
                tree.rows[Math.max(0, index - Math.ceil(height / rowHeight))]
                  ?.id;
              break;
            case "ArrowRight":
              if (
                !expanded.has(row.id) &&
                (children.length || item?.hasChildren)
              )
                toggle(row.id);
              else next = children[0];
              break;
            case "ArrowLeft":
              if (
                expanded.has(row.id) &&
                (children.length || item?.hasChildren)
              )
                toggle(row.id);
              else next = row.parentId ?? undefined;
              break;
            case "Enter":
              if (event.target === element)
                element
                  ?.querySelector<HTMLButtonElement>(
                    "[data-tree-primary],button:not([aria-expanded])",
                  )
                  ?.click();
              else return;
              break;
            default:
              return;
          }
          event.preventDefault();
          event.stopPropagation();
          if (next) setFocusedId(next);
        }}
      >
        <div
          role="presentation"
          style={{ height: tree.rows.length * rowHeight, position: "relative" }}
        >
          {[
            ...new Set([
              ...Array.from(
                { length: end - start },
                (_, offset) => start + offset,
              ),
              ...[...retainedIds, focusedId].flatMap((id) => {
                const index = id ? tree.indexById.get(id) : undefined;
                return index === undefined ? [] : [index];
              }),
            ]),
          ]
            .sort((a, b) => a - b)
            .map((index) => ({ row: tree.rows[index], index }))
            .map(({ row, index }) => {
              if (!row) return null;
              const item = byId.get(row.id);
              if (!item) return null;
              const hasChildren = Boolean(
                item.hasChildren || tree.children.get(row.id)?.length,
              );
              return (
                <div
                  key={row.id}
                  role="treeitem"
                  aria-hidden={motion.get(row.id)?.exiting || undefined}
                  inert={motion.get(row.id)?.exiting || undefined}
                  className={
                    motion.get(row.id)?.exiting
                      ? (motionClasses?.exit ?? "cat-row-exit")
                      : motion.get(row.id)?.entering
                        ? (motionClasses?.enter ?? "cat-row-enter")
                        : undefined
                  }
                  data-tree-id={row.id}
                  aria-level={row.depth + 1}
                  aria-posinset={row.position}
                  aria-setsize={row.siblings}
                  aria-expanded={hasChildren ? expanded.has(row.id) : undefined}
                  aria-selected={selectedId ? selectedId === row.id : undefined}
                  tabIndex={
                    row.id === (focusedId ?? selectedId ?? tree.rows[0]?.id)
                      ? 0
                      : -1
                  }
                  style={{
                    position: "absolute",
                    top: index * rowHeight,
                    height: rowHeight,
                    left: 0,
                    right: 0,
                  }}
                >
                  {renderItem(item, {
                    depth: row.depth,
                    expanded: expanded.has(row.id),
                    hasChildren,
                    toggle: () => toggle(row.id),
                  })}
                </div>
              );
            })}
        </div>
      </div>
      {onLoadMore && (
        <button type="button" className="cat-btn" onClick={onLoadMore}>
          Load more
        </button>
      )}
    </>
  );
}

/** Subscribe to topology separately from individual item snapshots. */
export function useCollection<T extends CollectionItem>({
  collection,
  active = true,
}: {
  collection: Collection<T>;
  active?: boolean;
}) {
  useEffect(
    () => (active ? collection.acquire() : undefined),
    [collection, active],
  );
  const revision = useSyncExternalStore(
    collection.subscribe,
    collection.getRevision,
    collection.getRevision,
  );
  return { revision, root: collection.getBranch(null) };
}
export function useCollectionItem<T extends CollectionItem>({
  collection,
  id,
}: {
  collection: Collection<T>;
  id: string;
}) {
  return useSyncExternalStore(
    (listener) => collection.subscribeItem(id, listener),
    () => collection.getItem(id),
    () => collection.getItem(id),
  );
}

export function CollectionTree<T extends CollectionItem>({
  collection,
  active = true,
  label,
  renderItem,
  height,
  rowHeight,
  selectedId,
  motionClasses,
  groupBy,
  project,
}: {
  collection: Collection<T>;
  active?: boolean;
  label: string;
  height?: number;
  rowHeight?: number;
  selectedId?: string;
  motionClasses?: { enter: string; exit: string };
  groupBy?: (item: T) => string;
  project?: (items: readonly T[]) => readonly T[];
  renderItem: (item: T, context: TreeRenderContext) => ReactNode;
}) {
  const { revision, root } = useCollection({ collection, active });
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const items = useMemo(
    () =>
      flattenCollection({ collection, expanded, revision }).flatMap(
        ({ id }) => {
          const item = collection.getItem(id);
          return item ? [item] : [];
        },
      ),
    [collection, expanded, revision],
  );
  const entries = useMemo(() => {
    const groups = new Map<
      string,
      { id: string; label: string; hasChildren: boolean }
    >();
    const projected = project ? project(items) : items;
    const roots = new Set(collection.getBranch(null).ids);
    const rows = projected.map((item) => {
      const group = groupBy && roots.has(item.id) ? groupBy(item) : undefined;
      if (group === undefined) return { ...item, itemId: item.id };
      const id = `collection-group:${group}`;
      groups.set(id, { id, label: group, hasChildren: true });
      return { ...item, parentId: id, itemId: item.id };
    });
    return [...groups.values(), ...rows];
  }, [items, groupBy, project, collection]);
  return (
    <>
      {root.status === "error" && (
        <p role="alert">
          {root.error}{" "}
          <button type="button" onClick={() => void collection.load()}>
            Retry
          </button>
        </p>
      )}
      {root.status === "loading" && !items.length && (
        <p role="status">Loading…</p>
      )}
      <Tree
        items={entries}
        label={label}
        height={height}
        rowHeight={rowHeight}
        selectedId={selectedId}
        motionClasses={motionClasses}
        expanded={expanded}
        onExpandedChange={setExpanded}
        loadChildren={(id) => {
          if (
            !id.startsWith("collection-group:") &&
            collection.getBranch(id).status === "idle"
          )
            void collection.load({ parentId: id });
        }}
        onLoadMore={
          root.cursor ? () => void collection.load({ more: true }) : undefined
        }
        renderItem={(item, context) =>
          "itemId" in item ? (
            <CollectionRow
              collection={collection}
              id={item.itemId}
              context={context}
              renderItem={renderItem}
            />
          ) : (
            <CollectionItemView
              id={item.id}
              label={item.label}
              expanded={context.expanded}
              onToggle={context.toggle}
            />
          )
        }
      />
      {[...expanded].map((id) => {
        const branch = collection.getBranch(id);
        return branch.status === "error" ? (
          <p key={id} role="alert">
            {branch.error}{" "}
            <button
              type="button"
              onClick={() => void collection.load({ parentId: id })}
            >
              Retry children
            </button>
          </p>
        ) : branch.cursor ? (
          <button
            key={id}
            type="button"
            onClick={() => void collection.load({ parentId: id, more: true })}
          >
            Load more children
          </button>
        ) : null;
      })}
    </>
  );
}
function CollectionRow<T extends CollectionItem>({
  collection,
  id,
  context,
  renderItem,
}: {
  collection: Collection<T>;
  id: string;
  context: TreeRenderContext;
  renderItem: (item: T, context: TreeRenderContext) => ReactNode;
}) {
  const item = useCollectionItem({ collection, id });
  const last = useRef(item);
  if (item) last.current = item;
  return last.current ? renderItem(last.current, context) : null;
}
