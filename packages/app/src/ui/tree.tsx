import {
  type CSSProperties,
  type DragEvent,
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
 * One drag-and-drop model for every tree. A host describes what a row
 * offers when dragged and what a target accepts; the tree owns the
 * pointer math, the insertion line, the "inside" highlight and the
 * keyboard-free HTML5 wiring. Positions are relative to a row: `before`
 * and `after` are siblings of that row, `inside` makes it the parent.
 * A `null` item means the tree's root (append at the end).
 */
export type TreeDropPosition = "before" | "after" | "inside";
export interface TreeDragSpec {
  /** MIME type → serialized payload, exactly as set on the DataTransfer. */
  data: Record<string, string>;
  effectAllowed?: "copy" | "move" | "copyMove";
}
export interface TreeDropTarget<T> {
  item: T | null;
  position: TreeDropPosition;
}
export interface TreeDragAndDrop<T> {
  /** Payload for dragging a row; null keeps the row static. */
  drag?: (item: T) => TreeDragSpec | null;
  /** Whether a payload with these MIME types may land on this target. */
  accept: (types: readonly string[], target: TreeDropTarget<T>) => boolean;
  onDrop: (transfer: DataTransfer, target: TreeDropTarget<T>) => void;
  /** A row of this tree started or stopped being dragged. */
  onDragStart?: (item: T) => void;
  onDragEnd?: () => void;
}

/**
 * Where a pointer over a row wants to drop: the outer quarters mean a
 * sibling slot, the middle means inside when the row can hold children.
 */
export function dropPositionFor({
  clientY,
  rect,
  allowInside,
}: {
  clientY: number;
  rect: { top: number; height: number };
  allowInside: boolean;
}): TreeDropPosition {
  const ratio = (clientY - rect.top) / Math.max(1, rect.height);
  if (allowInside) {
    if (ratio < 0.2) return "before";
    if (ratio > 0.8) return "after";
    return "inside";
  }
  return ratio < 0.5 ? "before" : "after";
}

function indexTree({
  items,
  expanded,
}: {
  items: readonly TreeItem[];
  expanded: ReadonlySet<string>;
}) {
  const byId = new Set(items.map((item) => item.id));
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
}

/**
 * A branch with rows past the loaded ones (`null` is the tree's root). The
 * tree reserves still placeholder rows at the branch's end and asks for the
 * next page once the person nears them; a failed read ends the branch with
 * its error and Retry instead.
 */
export interface TreeMore {
  /** Read the branch's next page. */
  load: () => void;
  /** The next page is being read. */
  loading?: boolean;
  /** The last read failed. */
  error?: string;
}

/** Placeholder rows a branch with more pages ends with. */
const PLACEHOLDER_ROWS = 3;
/** Placeholder bar widths, the section chrome's skeleton rhythm. */
const PLACEHOLDER_WIDTHS = [62, 84, 48];

type TreeSlot =
  | { kind: "row"; key: string; row: ReturnType<typeof indexTree>["rows"][0] }
  | {
      kind: "placeholder";
      key: string;
      parentId: string | null;
      depth: number;
      position: number;
    }
  | {
      kind: "error";
      key: string;
      parentId: string | null;
      depth: number;
      error: string;
    };
type TreePseudoSlot = Exclude<TreeSlot, { kind: "row" }>;

/**
 * The tree's rows in viewport order with each paginated branch's end
 * (placeholders, or its error) after its last loaded descendant.
 */
function layoutTree({
  rows,
  more,
  expanded,
}: {
  rows: ReturnType<typeof indexTree>["rows"];
  more?: ReadonlyMap<string | null, TreeMore>;
  expanded: ReadonlySet<string>;
}) {
  const ends: { parentId: string | null; at: number; depth: number }[] = [];
  const rowIndex = new Map(rows.map((row, index) => [row.id, index]));
  for (const parentId of more?.keys() ?? []) {
    if (parentId === null) {
      ends.push({ parentId, at: rows.length, depth: 0 });
      continue;
    }
    const index = rowIndex.get(parentId);
    const parent = index === undefined ? undefined : rows[index];
    if (index === undefined || !parent || !expanded.has(parentId)) continue;
    let at = index + 1;
    while (at < rows.length && (rows[at]?.depth ?? 0) > parent.depth) at += 1;
    ends.push({ parentId, at, depth: parent.depth + 1 });
  }
  // A nested branch ends inside its parent's, so it comes first.
  ends.sort((a, b) => a.at - b.at || b.depth - a.depth);
  const slots: TreeSlot[] = [];
  const firstSlot = new Map<string | null, number>();
  const pseudo = (end: (typeof ends)[number]) => {
    const page = more?.get(end.parentId);
    if (!page) return;
    const scope = `\u0000more\u0000${end.parentId ?? ""}\u0000`;
    firstSlot.set(end.parentId, slots.length);
    if (page.error)
      slots.push({
        kind: "error",
        key: `${scope}error`,
        parentId: end.parentId,
        depth: end.depth,
        error: page.error,
      });
    else
      for (let position = 0; position < PLACEHOLDER_ROWS; position += 1)
        slots.push({
          kind: "placeholder",
          // Named by where the branch ends: when a page lands they fade
          // where they stood as its rows arrive, rather than sliding
          // across them to the new end.
          key: `${scope}${end.at}\u0000${position}`,
          parentId: end.parentId,
          depth: end.depth,
          position,
        });
  };
  const pending = [...ends].reverse();
  const endsAt = (at: number) => {
    for (let end = pending.at(-1); end && end.at <= at; end = pending.at(-1)) {
      pending.pop();
      pseudo(end);
    }
  };
  rows.forEach((row, index) => {
    endsAt(index);
    slots.push({ kind: "row", key: row.id, row });
  });
  endsAt(rows.length);
  return {
    slots,
    /** Each real row's viewport index. */
    indexById: new Map(
      slots.flatMap((slot, index): [string, number][] =>
        slot.kind === "row" ? [[slot.row.id, index]] : [],
      ),
    ),
    /** Where each paginated branch's end begins. */
    ends: [...firstSlot].map(([parentId, index]) => ({ parentId, index })),
    /** The root's last loaded row ends here; drops on the root land there. */
    rootEnd: firstSlot.get(null) ?? slots.length,
  };
}

/** Visually hidden but read by assistive technology. */
const VISUALLY_HIDDEN: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  margin: -1,
  padding: 0,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
  border: 0,
};

/**
 * One virtual viewport for a whole tree. Source items can be paginated and have
 * unloaded children. Identity, focus and expansion survive reordering and updates.
 * Row height is explicit so custom presentations can choose a larger density.
 * A paginated branch (`more`) loads its next page as the person scrolls or
 * moves focus within one viewport of its end, and says so to assistive
 * technology.
 */
export function Tree<T extends TreeItem>({
  items: sourceItems,
  label,
  renderItem,
  loadChildren,
  more,
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
  dragAndDrop,
}: {
  items: readonly T[];
  label: string;
  renderItem: (item: T, context: TreeRenderContext) => ReactNode;
  dragAndDrop?: TreeDragAndDrop<T>;
  loadChildren?: (id: string) => void;
  /** Branches with rows past the loaded ones, by parent (`null`: the root). */
  more?: ReadonlyMap<string | null, TreeMore>;
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
  // A removed row leaves the layout at once, so the rows below start sliding
  // up while it fades where it stood: one motion, not a fade and then a
  // slide. Its last placement is remembered for that fade.
  const items = useMemo(
    () => animated.filter((entry) => !entry.exiting).map((entry) => entry.item),
    [animated],
  );
  const exiting = useMemo(
    () => animated.filter((entry) => entry.exiting),
    [animated],
  );
  const motion = useMemo(
    () => new Map(animated.map((entry) => [entry.key, entry])),
    [animated],
  );
  const placements = useRef(
    new Map<
      string,
      { top: number; depth: number; expanded: boolean; hasChildren: boolean }
    >(),
  );
  useEffect(() => {
    for (const id of placements.current.keys())
      if (!motion.has(id)) placements.current.delete(id);
  }, [motion]);
  // Only a row on screen in the last commit fades where it stood; one that
  // was scrolled away or folded into a collapsed parent simply leaves, since
  // its remembered place may now belong to another row.
  const onScreen = useRef<ReadonlySet<string>>(new Set());
  const renderedNow = new Set<string>();
  useLayoutEffect(() => {
    onScreen.current = renderedNow;
  });
  const viewport = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [overrides, setOverrides] = useState<ReadonlyMap<string, boolean>>(
    new Map(),
  );
  const [focusedId, setFocusedId] = useState<string>();
  const [drop, setDrop] = useState<{
    id: string | null;
    position: TreeDropPosition;
  } | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  // The row just dropped within this tree: dimmed like the drag source until
  // the host's reorder lands, then placed straight into its new slot (where
  // the insertion line was) while its neighbours slide around it.
  const [settling, setSettling] = useState<{
    id: string;
    index: number;
  } | null>(null);
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
  const tree = useMemo(() => indexTree({ items, expanded }), [items, expanded]);
  const layout = useMemo(
    () => layoutTree({ rows: tree.rows, more, expanded }),
    [tree.rows, more, expanded],
  );
  const pseudoList = layout.slots.filter(
    (slot): slot is TreePseudoSlot => slot.kind !== "row",
  );
  const pseudoSignature = pseudoList
    .map(
      (slot) =>
        `${slot.key}\u0001${slot.depth}\u0001${slot.kind === "error" ? slot.error : ""}`,
    )
    .join("\u0002");
  // One list per set of placeholders, so row changes alone never restart
  // their motion bookkeeping.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the signature versions the list.
  const pseudoSlots = useMemo(() => pseudoList, [pseudoSignature]);
  // Placeholders come and go like rows: in with the enter motion, out
  // fading where they stood while the rows that replace them arrive.
  const { entries: pseudoMotion } = useAnimatedItems({
    items: pseudoSlots,
    getKey: (slot) => slot.key,
  });
  const pseudoPlacements = useRef(new Map<string, number>());
  useEffect(() => {
    const live = new Set(pseudoMotion.map((entry) => entry.key));
    for (const key of pseudoPlacements.current.keys())
      if (!live.has(key)) pseudoPlacements.current.delete(key);
  }, [pseudoMotion]);
  const settledIndex = settling ? layout.indexById.get(settling.id) : undefined;
  const settleMoved =
    settling !== null &&
    settledIndex !== undefined &&
    settledIndex !== settling.index;
  useEffect(() => {
    if (!settling) return;
    if (settleMoved) {
      // Two frames: the row must be styled invisible in its new slot once
      // before it fades in, or the fade starts from the dimmed drag pose.
      let frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => setSettling(null));
      });
      return () => cancelAnimationFrame(frame);
    }
    const timer = setTimeout(() => setSettling(null), 600);
    return () => clearTimeout(timer);
  }, [settling, settleMoved]);
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
  const contentHeight = layout.slots.length * rowHeight;
  const actualHeight = Math.min(height, contentHeight);
  // Expanding or collapsing a folder moves every row below it. Rows are
  // absolutely placed, so without this they (and the tree's own height)
  // jump while only the folder's children fade: the rest must slide.
  const slide = useMemo(
    () =>
      typeof matchMedia === "function" &&
      matchMedia("(prefers-reduced-motion: reduce)").matches
        ? undefined
        : // The host's structural motion token; the shell, which loads
          // no kit sheet, falls back to its own 200ms.
          "var(--cat-motion-base, 200ms) var(--ease-standard, cubic-bezier(0.2, 0, 0, 1))",
    [],
  );
  const reveal = useCallback(
    (id: string) => {
      const index = layout.indexById.get(id) ?? -1;
      const node = viewport.current;
      if (index < 0 || !node) return;
      const top = index * rowHeight;
      if (top < node.scrollTop) node.scrollTop = top;
      else if (top + rowHeight > node.scrollTop + actualHeight)
        node.scrollTop = top + rowHeight - actualHeight;
      setScrollTop(node.scrollTop);
    },
    [layout, rowHeight, actualHeight],
  );
  const previousAnchor = useRef<{ id: string; offset: number } | undefined>(
    undefined,
  );
  useLayoutEffect(() => {
    const anchor = previousAnchor.current;
    const node = viewport.current;
    if (node && anchor) {
      const index = layout.indexById.get(anchor.id);
      if (index !== undefined) {
        node.scrollTop = index * rowHeight + anchor.offset;
        setScrollTop(node.scrollTop);
      }
    }
    if (focusedId && !tree.indexById.has(focusedId)) {
      const previous = byId.get(focusedId)?.parentId;
      setFocusedId(
        previous && byId.has(previous) ? previous : tree.rows[0]?.id,
      );
    }
  }, [layout, tree, rowHeight, byId, focusedId]);
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
      layout.slots.length - 1,
    ),
  );
  const end = Math.min(
    layout.slots.length,
    start + Math.ceil(height / rowHeight) + overscan * 2,
  );
  // Within one viewport of a branch's end, its next page is read: by the
  // time the person gets there it has usually arrived. Moving focus scrolls
  // too, so arrow keys load like the wheel does.
  const firstVisible = Math.floor(scrollTop / rowHeight);
  const lastVisible = Math.floor(
    (scrollTop + Math.max(actualHeight, rowHeight) - 1) / rowHeight,
  );
  const ahead = Math.ceil(height / rowHeight);
  const near = layout.ends
    .filter(({ parentId, index }) => {
      const page = more?.get(parentId);
      return (
        page &&
        !page.loading &&
        !page.error &&
        index >= firstVisible - ahead &&
        index <= lastVisible + ahead
      );
    })
    .map(({ parentId }) => parentId);
  // The root is "\u0001" here; item ids never hold that control character.
  const nearKey = near.map((id) => id ?? "\u0001").join("\u0000");
  const latestMore = useRef({ more, near });
  latestMore.current = { more, near };
  // biome-ignore lint/correctness/useExhaustiveDependencies: nearKey names exactly the branches to read; the ref holds their current loaders.
  useEffect(() => {
    const { more: pages, near: branches } = latestMore.current;
    for (const parentId of branches) pages?.get(parentId)?.load();
  }, [nearKey]);
  // Screen readers hear a page start and land; a failed page is an alert.
  const paging = [...(more?.values() ?? [])].some((page) => page.loading);
  const pagingFrom = useRef<number | null>(null);
  const [announcement, setAnnouncement] = useState("");
  useEffect(() => {
    if (paging) {
      if (pagingFrom.current !== null) return;
      pagingFrom.current = tree.rows.length;
      setAnnouncement(`Loading more in ${label}`);
      return;
    }
    if (pagingFrom.current === null) return;
    const added = tree.rows.length - pagingFrom.current;
    pagingFrom.current = null;
    setAnnouncement(added > 0 ? `${added} more in ${label}` : "");
  }, [paging, tree.rows.length, label]);
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
  const dropTargetFor = (
    id: string | null,
    position: TreeDropPosition,
  ): TreeDropTarget<T> => ({
    item: id === null ? null : (byId.get(id) ?? null),
    position,
  });
  const clearDrop = () => {
    setDrop(null);
    setDraggingId(null);
  };
  const settleDropped = () => {
    const index = draggingId ? layout.indexById.get(draggingId) : undefined;
    if (draggingId && index !== undefined)
      setSettling({ id: draggingId, index });
  };
  const rootDropHandlers = dragAndDrop
    ? {
        onDragOver: (event: DragEvent<HTMLElement>) => {
          // Rows handle their own drops; the space past the last row
          // appends to the root.
          if (
            event.target instanceof HTMLElement &&
            event.target.closest("[data-tree-id]")
          )
            return;
          const target = dropTargetFor(null, "inside");
          if (!dragAndDrop.accept(event.dataTransfer.types, target)) {
            setDrop(null);
            return;
          }
          event.preventDefault();
          event.dataTransfer.dropEffect =
            event.dataTransfer.effectAllowed === "copy" ? "copy" : "move";
          setDrop((current) =>
            current?.id === null && current.position === "inside"
              ? current
              : { id: null, position: "inside" },
          );
        },
        onDragLeave: (event: DragEvent<HTMLElement>) => {
          if (
            event.relatedTarget instanceof Node &&
            event.currentTarget.contains(event.relatedTarget)
          )
            return;
          setDrop(null);
        },
        onDrop: (event: DragEvent<HTMLElement>) => {
          if (
            event.target instanceof HTMLElement &&
            event.target.closest("[data-tree-id]")
          )
            return;
          const target = dropTargetFor(null, "inside");
          if (!dragAndDrop.accept(event.dataTransfer.types, target)) return;
          event.preventDefault();
          settleDropped();
          clearDrop();
          dragAndDrop.onDrop(event.dataTransfer, target);
        },
        onDragEnd: clearDrop,
      }
    : {};
  const rowDropHandlers = (item: T, hasChildren: boolean) =>
    dragAndDrop
      ? {
          onDragOver: (event: DragEvent<HTMLElement>) => {
            const position = dropPositionFor({
              clientY: event.clientY,
              rect: event.currentTarget.getBoundingClientRect(),
              allowInside:
                hasChildren &&
                dragAndDrop.accept(
                  event.dataTransfer.types,
                  dropTargetFor(item.id, "inside"),
                ),
            });
            const target = dropTargetFor(item.id, position);
            if (
              item.id === draggingId ||
              !dragAndDrop.accept(event.dataTransfer.types, target)
            ) {
              setDrop(null);
              return;
            }
            event.preventDefault();
            event.stopPropagation();
            event.dataTransfer.dropEffect =
              event.dataTransfer.effectAllowed === "copy" ? "copy" : "move";
            setDrop((current) =>
              current?.id === item.id && current.position === position
                ? current
                : { id: item.id, position },
            );
          },
          onDrop: (event: DragEvent<HTMLElement>) => {
            const position =
              drop?.id === item.id
                ? drop.position
                : dropPositionFor({
                    clientY: event.clientY,
                    rect: event.currentTarget.getBoundingClientRect(),
                    allowInside: hasChildren,
                  });
            const target = dropTargetFor(item.id, position);
            if (!dragAndDrop.accept(event.dataTransfer.types, target)) return;
            event.preventDefault();
            event.stopPropagation();
            settleDropped();
            clearDrop();
            dragAndDrop.onDrop(event.dataTransfer, target);
          },
        }
      : {};
  const dragHandlers = (item: T) => {
    const spec = dragAndDrop?.drag?.(item);
    if (!spec) return {};
    return {
      draggable: true,
      onDragStart: (event: DragEvent<HTMLElement>) => {
        for (const [type, value] of Object.entries(spec.data))
          event.dataTransfer.setData(type, value);
        event.dataTransfer.effectAllowed = spec.effectAllowed ?? "copyMove";
        setDraggingId(item.id);
        dragAndDrop?.onDragStart?.(item);
      },
      onDragEnd: () => {
        clearDrop();
        dragAndDrop?.onDragEnd?.();
      },
    };
  };
  const dropLineIndex =
    drop && drop.id !== null && drop.position !== "inside"
      ? layout.indexById.get(drop.id)
      : undefined;
  const slotTop =
    dropLineIndex === undefined
      ? drop?.id === null
        ? layout.rootEnd * rowHeight
        : undefined
      : dropLineIndex * rowHeight +
        (drop?.position === "after" ? rowHeight : 0);
  // The line (2px, with a dot reaching 3px above and 5px below) stays inside
  // the viewport, which clips: at the very top or bottom it hugs the edge.
  const dropLineTop =
    slotTop === undefined
      ? undefined
      : Math.max(3, Math.min(slotTop, contentHeight - 5));
  return (
    <>
      <div
        ref={viewport}
        role="tree"
        aria-label={label}
        className={className}
        data-drop-root={drop?.id === null ? drop.position : undefined}
        data-dragging={draggingId ? "true" : undefined}
        {...rootDropHandlers}
        style={{
          // Rows that fit never scroll: while the height tweens to fit new
          // rows, an auto overflow flashed a scrollbar.
          overflow: contentHeight > height ? "auto" : "hidden",
          // A tree that fits its rows must not trap the wheel: containment
          // on a scroller with nothing to scroll blocks the surrounding
          // sidebar section from scrolling at all.
          overscrollBehavior: actualHeight < contentHeight ? "contain" : "auto",
          height: actualHeight,
          transition: slide && `height ${slide}`,
          ...style,
        }}
        onScroll={(event) => {
          const top = event.currentTarget.scrollTop;
          const slot = layout.slots[Math.floor(top / rowHeight)];
          previousAnchor.current =
            slot?.kind === "row"
              ? { id: slot.row.id, offset: top % rowHeight }
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
          style={{
            height: contentHeight,
            position: "relative",
            transition: slide && `height ${slide}`,
          }}
        >
          {dropLineTop !== undefined && (
            <div
              aria-hidden="true"
              data-tree-drop-line
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                top: dropLineTop,
                pointerEvents: "none",
              }}
            />
          )}
          {[
            ...new Set([
              ...Array.from(
                { length: end - start },
                (_, offset) => start + offset,
              ),
              ...[...retainedIds, focusedId].flatMap((id) => {
                const index = id ? layout.indexById.get(id) : undefined;
                return index === undefined ? [] : [index];
              }),
              // A failed page's Retry stays reachable from the keyboard.
              ...layout.slots.flatMap((slot, index) =>
                slot.kind === "error" ? [index] : [],
              ),
            ]),
          ]
            .sort((a, b) => a - b)
            .map((index) => ({ slot: layout.slots[index], index }))
            .map(({ slot, index }) => {
              if (!slot) return null;
              if (slot.kind !== "row") {
                renderedNow.add(slot.key);
                pseudoPlacements.current.set(slot.key, index * rowHeight);
                return (
                  <TreePseudoRow
                    key={slot.key}
                    slot={slot}
                    top={index * rowHeight}
                    rowHeight={rowHeight}
                    slide={slide}
                    className={
                      pseudoMotion.find((entry) => entry.key === slot.key)
                        ?.entering
                        ? (motionClasses?.enter ?? "cat-row-enter")
                        : undefined
                    }
                    onRetry={() => more?.get(slot.parentId)?.load()}
                  />
                );
              }
              const row = slot.row;
              const item = byId.get(row.id);
              if (!item) return null;
              const hasChildren = Boolean(
                item.hasChildren || tree.children.get(row.id)?.length,
              );
              renderedNow.add(row.id);
              placements.current.set(row.id, {
                top: index * rowHeight,
                depth: row.depth,
                expanded: expanded.has(row.id),
                hasChildren,
              });
              return (
                <div
                  key={row.id}
                  role="treeitem"
                  className={
                    motion.get(row.id)?.entering
                      ? (motionClasses?.enter ?? "cat-row-enter")
                      : undefined
                  }
                  data-tree-id={row.id}
                  data-tree-dragging={
                    row.id === draggingId ||
                    (row.id === settling?.id && !settleMoved)
                      ? ""
                      : undefined
                  }
                  data-tree-settling={
                    settleMoved && row.id === settling?.id ? "" : undefined
                  }
                  data-drop={
                    drop?.id === row.id && drop.position === "inside"
                      ? "inside"
                      : undefined
                  }
                  {...dragHandlers(item)}
                  {...rowDropHandlers(item, hasChildren)}
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
                    transition:
                      settleMoved && row.id === settling?.id
                        ? "none"
                        : slide && `top ${slide}`,
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
          {pseudoMotion.map(({ key, item: slot, exiting: leaving }) => {
            const top = pseudoPlacements.current.get(key);
            if (!leaving || top === undefined || !onScreen.current.has(key))
              return null;
            renderedNow.add(key);
            return (
              <TreePseudoRow
                key={`exiting:${key}`}
                slot={slot}
                top={top}
                rowHeight={rowHeight}
                className={motionClasses?.exit ?? "cat-row-exit"}
                leaving
              />
            );
          })}
          {exiting.map(({ key, item }) => {
            const placed = placements.current.get(key);
            if (!placed || !onScreen.current.has(key)) return null;
            renderedNow.add(key);
            return (
              <div
                key={`exiting:${key}`}
                aria-hidden="true"
                inert
                data-tree-exiting={key}
                className={motionClasses?.exit ?? "cat-row-exit"}
                style={{
                  position: "absolute",
                  top: placed.top,
                  height: rowHeight,
                  left: 0,
                  right: 0,
                }}
              >
                {renderItem(item, {
                  depth: placed.depth,
                  expanded: placed.expanded,
                  hasChildren: placed.hasChildren,
                  toggle: () => {},
                })}
              </div>
            );
          })}
        </div>
      </div>
      <div role="status" aria-live="polite" style={VISUALLY_HIDDEN}>
        {announcement}
      </div>
    </>
  );
}

/**
 * A paginated branch's end: still placeholder rows shaped like the section
 * skeleton, or the failed read with Retry.
 */
function TreePseudoRow({
  slot,
  top,
  rowHeight,
  slide,
  className,
  leaving = false,
  onRetry,
}: {
  slot: TreePseudoSlot;
  top: number;
  rowHeight: number;
  slide?: string;
  className?: string;
  leaving?: boolean;
  onRetry?: () => void;
}) {
  const style: CSSProperties = {
    position: "absolute",
    top,
    height: rowHeight,
    left: 0,
    right: 0,
    // Placeholders slide with the rows when a branch above them opens.
    transition: slide && !leaving ? `top ${slide}` : undefined,
    paddingInlineStart: 8 + slot.depth * 14,
  };
  if (slot.kind === "error")
    return (
      <div
        role={leaving ? undefined : "alert"}
        aria-hidden={leaving || undefined}
        inert={leaving || undefined}
        data-tree-more="error"
        className={className}
        style={style}
      >
        <span>{slot.error}</span>
        <button type="button" onClick={onRetry}>
          Retry
        </button>
      </div>
    );
  return (
    <div
      aria-hidden="true"
      data-tree-more="placeholder"
      className={className}
      style={style}
    >
      <span />
      <span
        style={{
          width: `${PLACEHOLDER_WIDTHS[slot.position % PLACEHOLDER_WIDTHS.length]}%`,
        }}
      />
    </div>
  );
}

/** Subscribe to topology separately from individual item snapshots. */
export function useCollection<T extends CollectionItem>({
  collection,
  active = true,
  projected = false,
  mode = "full",
}: {
  collection: Collection<T>;
  active?: boolean;
  /** Projections depend on item values as well as topology. */
  projected?: boolean;
  /** Preview owners refresh only the first root page until a full view returns. */
  mode?: "full" | "preview";
}) {
  useEffect(
    () => (active ? collection.acquire({ mode }) : undefined),
    [collection, active, mode],
  );
  const revision = useSyncExternalStore(
    projected ? collection.subscribeSnapshot : collection.subscribe,
    projected ? collection.getSnapshotRevision : collection.getRevision,
    projected ? collection.getSnapshotRevision : collection.getRevision,
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
  renderStatus,
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
  dragAndDrop,
}: {
  dragAndDrop?: TreeDragAndDrop<T>;
  renderStatus?: (
    branch: import("../collection.js").CollectionBranch,
  ) => ReactNode;
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
  const { revision, root } = useCollection({
    collection,
    active,
    projected: Boolean(project || groupBy),
  });
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const branches = useMemo(
    () => ({ collection, releases: new Map<string, () => void>() }),
    [collection],
  );
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
  const visibleBranches = useMemo(
    () =>
      indexTree({ items: entries, expanded })
        .rows.filter(
          ({ id }) => expanded.has(id) && collection.getItem(id)?.hasChildren,
        )
        .map(({ id }) => id),
    [entries, expanded, collection],
  );
  useEffect(() => {
    const wanted = new Set(active ? visibleBranches : []);
    for (const [id, release] of branches.releases) {
      if (!wanted.has(id)) {
        release();
        branches.releases.delete(id);
      }
    }
    for (const parentId of wanted) {
      if (!branches.releases.has(parentId))
        branches.releases.set(parentId, collection.acquire({ parentId }));
    }
  }, [active, collection, visibleBranches, branches]);
  useEffect(
    () => () => {
      for (const release of branches.releases.values()) release();
      branches.releases.clear();
    },
    [branches],
  );
  // Every loaded branch with rows past it reads them as the person nears
  // its end; nothing reads while the view is hidden.
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision versions every branch read here.
  const more = useMemo(() => {
    if (!active) return undefined;
    const pages = new Map<string | null, TreeMore>();
    for (const parentId of [null, ...visibleBranches]) {
      const branch = collection.getBranch(parentId);
      if (branch.cursor)
        pages.set(parentId, {
          load: () => void collection.load({ parentId, more: true }),
          loading: branch.paging,
          error: branch.pageError,
        });
    }
    return pages.size ? pages : undefined;
  }, [active, collection, visibleBranches, revision, root]);
  return (
    <>
      {renderStatus?.(root)}
      {!renderStatus && root.status === "error" && (
        <p role="alert">
          {root.error}{" "}
          <button type="button" onClick={() => void collection.load()}>
            Retry
          </button>
        </p>
      )}
      {!renderStatus && root.status === "loading" && !items.length && (
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
        more={more}
        dragAndDrop={
          dragAndDrop
            ? {
                drag: (entry) =>
                  "itemId" in entry
                    ? (dragAndDrop.drag?.(
                        collection.getItem(entry.itemId) as T,
                      ) ?? null)
                    : null,
                accept: (types, target) =>
                  dragAndDrop.accept(types, {
                    item:
                      target.item && "itemId" in target.item
                        ? ((collection.getItem(target.item.itemId) as T) ??
                          null)
                        : null,
                    position: target.position,
                  }),
                onDrop: (transfer, target) =>
                  dragAndDrop.onDrop(transfer, {
                    item:
                      target.item && "itemId" in target.item
                        ? ((collection.getItem(target.item.itemId) as T) ??
                          null)
                        : null,
                    position: target.position,
                  }),
              }
            : undefined
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
      {visibleBranches.map((id) => {
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
