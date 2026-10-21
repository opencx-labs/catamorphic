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
  /** Takes rows dropped inside it while it holds none yet. */
  acceptsChildren?: boolean;
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
 * tree holds the branch's end with still placeholder rows and reads the next
 * page as the person moves toward it (see `Tree`); a failed read ends the
 * branch with its error and Retry instead.
 */
export interface TreeMore {
  /** Read the branch's next page. */
  load: () => void;
  /** The next page is being read. */
  loading?: boolean;
  /** The last read failed. */
  error?: string;
  /**
   * Names the next page (a cursor), so the tree can tell a read landed even
   * when it lands before the tree sees it loading.
   */
  next?: string;
}

/** Placeholder rows a branch with more pages ends with. */
const PLACEHOLDER_ROWS = 3;
/** Placeholder bar widths, the section chrome's skeleton rhythm. */
const PLACEHOLDER_WIDTHS = [62, 84, 48];
/** Pages the tree reads on its own per gesture before it waits for another. */
const READS_PER_GESTURE = 3;
const NO_BRANCHES: ReadonlySet<string | null> = new Set();

type TreeRow = ReturnType<typeof indexTree>["rows"][number];
type TreeSlot =
  | { kind: "row"; key: string; row: TreeRow }
  | {
      kind: "placeholder";
      key: string;
      parentId: string | null;
      depth: number;
      position: number;
    }
  /** The branch's last read failed: its error and Retry. */
  | {
      kind: "error";
      key: string;
      parentId: string | null;
      depth: number;
      error: string;
    }
  /** The tree stopped reading on its own here: Show more. */
  | { kind: "paused"; key: string; parentId: string | null; depth: number };
type TreePseudoSlot = Exclude<TreeSlot, { kind: "row" }>;

/**
 * The tree's rows in viewport order with each paginated branch's end
 * (placeholders, its error, or Show more) after its last loaded descendant.
 * The root's end comes before its tail rows, which belong past it.
 */
function layoutTree({
  rows,
  more,
  expanded,
  paused,
  tailIds,
}: {
  rows: readonly TreeRow[];
  more?: ReadonlyMap<string | null, TreeMore>;
  expanded: ReadonlySet<string>;
  paused: ReadonlySet<string | null>;
  tailIds: ReadonlySet<string>;
}) {
  const ends: { parentId: string | null; at: number; depth: number }[] = [];
  const rowIndex = new Map(rows.map((row, index) => [row.id, index]));
  for (const parentId of more?.keys() ?? []) {
    if (parentId === null) {
      const tail = rows.findIndex(
        (row) => row.depth === 0 && tailIds.has(row.id),
      );
      ends.push({ parentId, at: tail < 0 ? rows.length : tail, depth: 0 });
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
  const lastRow = new Map<string | null, string>();
  const pseudo = (end: (typeof ends)[number]) => {
    const page = more?.get(end.parentId);
    if (!page) return;
    // Keys name the branch, not where it ends: a page landing above them
    // or a row added at the top moves them, never re-creates them.
    const scope = `\u0000more\u0000${end.parentId ?? ""}\u0000`;
    const previous = rows[end.at - 1];
    if (previous && end.at > (rowIndex.get(end.parentId ?? "") ?? -1) + 1)
      lastRow.set(end.parentId, previous.id);
    firstSlot.set(end.parentId, slots.length);
    const base = { parentId: end.parentId, depth: end.depth };
    if (page.error)
      slots.push({
        ...base,
        kind: "error",
        key: `${scope}error`,
        error: page.error,
      });
    else if (paused.has(end.parentId) && !page.loading)
      slots.push({ ...base, kind: "paused", key: `${scope}paused` });
    else
      for (let position = 0; position < PLACEHOLDER_ROWS; position += 1)
        slots.push({
          ...base,
          kind: "placeholder",
          key: `${scope}${position}`,
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
    /** Each paginated branch's last loaded row, where Retry leaves focus. */
    lastRow,
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

/** What a host dispatches on a tree's scroller to move focus into it. */
const TREE_FOCUS_EVENT = "cat-tree-focus";
/** What a tree dispatches from its scroller when an arrow passes an end. */
const TREE_LEAVE_EVENT = "cat-tree-leave";

/** A host's request for focus in a tree (`focusTreeRow`). */
interface TreeFocusRequest {
  which: "first" | "last" | "selected";
  /** A keyboard move: the ring shows where focus lands. */
  visible: boolean;
}

/**
 * Arrows past a tree's first or last row (with nothing left to load there),
 * for a host that goes on from there into a list beside it. Listens on
 * `container`, around the trees; `onLeave` gets the way and the tree's
 * scroller, and says whether it moved focus on. The tree keeps the key
 * either way, so an end never scrolls what holds it. Returns the
 * unsubscribe.
 */
export function onTreeLeave({
  container,
  onLeave,
}: {
  container: Element;
  onLeave: (leave: { direction: "up" | "down"; scroller: Element }) => boolean;
}): () => void {
  const listener = (event: Event) => {
    const detail: unknown = event instanceof CustomEvent ? event.detail : null;
    const direction =
      typeof detail === "object" && detail !== null && "direction" in detail
        ? detail.direction
        : undefined;
    if (
      (direction === "up" || direction === "down") &&
      event.target instanceof Element &&
      onLeave({ direction, scroller: event.target })
    )
      event.preventDefault();
  };
  container.addEventListener(TREE_LEAVE_EVENT, listener);
  return () => container.removeEventListener(TREE_LEAVE_EVENT, listener);
}

/**
 * Moves focus into a tree: its first or last row, or its selected one. The
 * row is revealed and, when the tree draws it, focused before this returns,
 * so a host can count the move as its own; a row revealed from outside the
 * drawn window is drawn by the next frame, when the host asks again.
 * `scroller` is the tree's `[data-tree-viewport]`; `visible` says the
 * keyboard made the move, so the focus ring shows. True when the tree has
 * such a row.
 */
export function focusTreeRow({
  scroller,
  which,
  visible = true,
}: {
  scroller: Element;
  which: TreeFocusRequest["which"];
  visible?: boolean;
}): boolean {
  return !scroller.dispatchEvent(
    new CustomEvent<TreeFocusRequest>(TREE_FOCUS_EVENT, {
      detail: { which, visible },
      cancelable: true,
    }),
  );
}

/**
 * One virtual viewport for a whole tree. Source items can be paginated and have
 * unloaded children. Identity, focus and expansion survive reordering and updates.
 * Row height is explicit so custom presentations can choose a larger density.
 *
 * A paginated branch (`more`) reads its next page when the person moves
 * within one viewport of its end: each gesture (wheel, touch, a press on the
 * scrollbar, keyboard movement) allows up to three reads while each one
 * moves the branch's end down. A read that adds no visible row (a filter, a
 * closed group) or a spent gesture leaves Show more at the end until the
 * next gesture, so a list never reads its whole history on its own. Reads
 * the person caused are announced to assistive technology.
 */
export function Tree<T extends TreeItem>({
  items: sourceItems,
  label,
  renderItem,
  loadChildren,
  more,
  tail,
  selectedId,
  rowHeight = 28,
  height = 336,
  indent = 0,
  overscan = 5,
  expanded: controlled,
  onExpandedChange,
  defaultExpanded = true,
  className,
  style,
  onViewport,
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
  /**
   * Root rows that belong past the root's unloaded rows (an open item older
   * than every loaded one): shown after the root's end, without reading
   * everything above them. A tail row that arrives in `items` leaves the
   * tail.
   */
  tail?: readonly T[];
  selectedId?: string;
  rowHeight?: number;
  height?: number;
  /**
   * How far each level of depth sets a row in, in pixels. The row's own box
   * starts there, so its background, its drop outline and the focus ring
   * all share the indented box.
   */
  indent?: number;
  overscan?: number;
  expanded?: ReadonlySet<string>;
  onExpandedChange?: (expanded: ReadonlySet<string>) => void;
  defaultExpanded?: boolean;
  /** Class for the scroller. */
  className?: string;
  style?: CSSProperties;
  /**
   * Called with the scroller once it is mounted (a host's overflow hint,
   * say); may return its cleanup. Keep it stable.
   */
  onViewport?: (viewport: HTMLDivElement) => (() => void) | undefined;
  motionClasses?: { enter: string; exit: string };
}) {
  const withTail = useMemo(() => {
    if (!tail?.length) return sourceItems;
    const known = new Set(sourceItems.map((item) => item.id));
    const extra = tail.filter((item) => !known.has(item.id));
    return extra.length ? [...sourceItems, ...extra] : sourceItems;
  }, [sourceItems, tail]);
  const tailIds = useMemo(
    () => new Set((tail ?? []).map((item) => item.id)),
    [tail],
  );
  const { entries: animated } = useAnimatedItems({
    items: withTail,
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
  useEffect(() => {
    const node = viewport.current;
    return node && onViewport ? onViewport(node) : undefined;
  }, [onViewport]);
  const [scrollTop, setScrollTop] = useState(0);
  const [overrides, setOverrides] = useState<ReadonlyMap<string, boolean>>(
    new Map(),
  );
  const [focusedId, setFocusedId] = useState<string>();
  // The keyboard's ring: one box that glides from row to row while focus
  // moves inside the tree (data-tree-focus), instead of a ring blinking off
  // one row and on the next. It arrives where focus enters, without a glide.
  const [ring, setRing] = useState<{ id: string; glide: boolean } | null>(null);
  // Focus is in the tree, or was in a row that has since gone: only then
  // does focus follow the roving row (a click elsewhere leaves it be).
  const holdsFocus = useRef(false);
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
  // Branches where the tree stopped reading on its own (Show more).
  const [paused, setPaused] = useState(NO_BRANCHES);
  const layout = useMemo(
    () => layoutTree({ rows: tree.rows, more, expanded, paused, tailIds }),
    [tree.rows, more, expanded, paused, tailIds],
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
      // Opening a branch is the person moving the list.
      allowReads();
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
      // The scroller's scroll padding (a faded edge's) is kept clear too.
      const padding = getComputedStyle(node);
      const before = Number.parseFloat(padding.scrollPaddingTop) || 0;
      const after = Number.parseFloat(padding.scrollPaddingBottom) || 0;
      const top = index * rowHeight;
      if (top - before < node.scrollTop)
        node.scrollTop = Math.max(0, top - before);
      else if (top + rowHeight + after > node.scrollTop + actualHeight)
        node.scrollTop = top + rowHeight + after - actualHeight;
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
    const active = document.activeElement;
    if (
      !viewport.current?.contains(active) &&
      !(holdsFocus.current && (active === null || active === document.body))
    )
      return;
    reveal(focusedId);
    const node = [
      ...(viewport.current?.querySelectorAll<HTMLElement>("[data-tree-id]") ??
        []),
    ].find((entry) => entry.dataset.treeId === focusedId);
    node?.focus({ preventScroll: true });
  }, [focusedId, reveal]);
  // A host asks for a row by name (focusTreeRow): the first, the last or
  // the selected one, revealed and focused. Handled, the event is canceled.
  useEffect(() => {
    const node = viewport.current;
    if (!node) return;
    const onFocusRequest = (event: Event) => {
      const request: Partial<TreeFocusRequest> =
        event instanceof CustomEvent ? (event.detail ?? {}) : {};
      const which = request.which;
      const visible = request.visible !== false;
      const id =
        which === "first"
          ? tree.rows[0]?.id
          : which === "last"
            ? tree.rows.at(-1)?.id
            : which === "selected" &&
                selectedId &&
                tree.indexById.has(selectedId)
              ? selectedId
              : undefined;
      if (!id) return;
      event.preventDefault();
      // Revealed and, if drawn, focused here, inside the host's call; the
      // roving effect above leaves the row to it.
      reveal(id);
      lastFocused.current = id;
      if (id !== focusedId) setFocusedId(id);
      [...node.querySelectorAll<HTMLElement>("[data-tree-id]")]
        .find((entry) => entry.dataset.treeId === id)
        ?.focus({ preventScroll: true, focusVisible: visible });
    };
    node.addEventListener(TREE_FOCUS_EVENT, onFocusRequest);
    return () => node.removeEventListener(TREE_FOCUS_EVENT, onFocusRequest);
  }, [tree, selectedId, focusedId, reveal]);
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
  const ends = layout.ends.map(({ parentId, index }) => ({
    parentId,
    index,
    near: index >= firstVisible - ahead && index <= lastVisible + ahead,
  }));
  const auto = useRef<{
    /** Reads left before the tree waits for the person again. */
    budget: number;
    /** Where each branch ended, and its next page, when the tree asked. */
    asked: Map<string | null, { at: number; next?: string }>;
    /** Branches whose last read showed nothing new. */
    stalled: Set<string | null>;
    /** Row count when the person's reads began, for one announcement. */
    from: number | null;
    /** The gesture the last pass saw. */
    gesture: number;
  }>({
    budget: 0,
    asked: new Map(),
    stalled: new Set(),
    from: null,
    gesture: 0,
  });
  const [gesture, setGesture] = useState(0);
  const [announcement, setAnnouncement] = useState("");
  /** The person moved the list: the tree may read on its own again. */
  const allowReads = () => {
    const state = auto.current;
    if (
      state.budget === READS_PER_GESTURE &&
      !state.stalled.size &&
      !state.asked.size
    )
      return;
    state.budget = READS_PER_GESTURE;
    state.stalled.clear();
    setGesture((value) => value + 1);
  };
  const latest = useRef({ more, ends, rows: tree.rows.length, gesture });
  latest.current = { more, ends, rows: tree.rows.length, gesture };
  const autoKey = [
    gesture,
    ...ends.map(({ parentId, index, near }) => {
      const page = more?.get(parentId);
      return [
        parentId ?? "\u0001",
        index,
        near,
        page?.next ?? "",
        Boolean(page?.loading),
        page?.error ?? "",
      ].join("\u0001");
    }),
  ].join("\u0000");
  // biome-ignore lint/correctness/useExhaustiveDependencies: autoKey names every input; the ref holds their current values.
  useEffect(() => {
    const state = auto.current;
    const { more: pages, ends: current, rows, gesture: moved } = latest.current;
    for (const [parentId, ask] of state.asked) {
      const page = pages?.get(parentId);
      // Gone, or (once the person moves again) an ask that never went
      // anywhere: a host whose load did nothing must not block the branch.
      if (
        !page ||
        (moved !== state.gesture && !page.loading && page.next === ask.next)
      )
        state.asked.delete(parentId);
    }
    state.gesture = moved;
    const waiting = new Set<string | null>();
    for (const { parentId, index, near: isNear } of current) {
      const page = pages?.get(parentId);
      if (!page || page.loading) continue;
      const asked = state.asked.get(parentId);
      if (page.error) {
        state.asked.delete(parentId);
        continue;
      }
      if (asked) {
        // Not landed yet (or never started): leave it be.
        if (asked.next === page.next) continue;
        state.asked.delete(parentId);
        // A page that moved nothing on screen (filtered out, in a closed
        // group) stops the reading until the person moves again.
        if (index <= asked.at) state.stalled.add(parentId);
      }
      if (!isNear) continue;
      if (state.stalled.has(parentId) || state.budget <= 0) {
        waiting.add(parentId);
        continue;
      }
      state.budget -= 1;
      state.asked.set(parentId, { at: index, next: page.next });
      if (state.from === null) {
        state.from = rows;
        setAnnouncement(`Loading more in ${label}`);
      }
      page.load();
    }
    const busy =
      state.asked.size > 0 ||
      [...(pages?.values() ?? [])].some((page) => page.loading);
    if (!busy && state.from !== null) {
      const added = rows - state.from;
      state.from = null;
      setAnnouncement(added > 0 ? `${added} more in ${label}` : "");
    }
    setPaused((previous) =>
      previous.size === waiting.size &&
      [...waiting].every((parentId) => previous.has(parentId))
        ? previous
        : waiting,
    );
  }, [autoKey]);
  /** Retry or Show more: read now, leaving focus on the last loaded row. */
  const readNow = (parentId: string | null) => {
    const page = more?.get(parentId);
    const end = layout.ends.find((entry) => entry.parentId === parentId);
    if (!page || !end) return;
    const last = layout.lastRow.get(parentId);
    if (
      last &&
      viewport.current?.contains(document.activeElement) &&
      document.activeElement?.closest("[data-tree-end]")
    ) {
      const row = [
        ...viewport.current.querySelectorAll<HTMLElement>("[data-tree-id]"),
      ].find((entry) => entry.dataset.treeId === last);
      if (row) row.focus({ preventScroll: true });
      setFocusedId(last);
    }
    const state = auto.current;
    state.budget = READS_PER_GESTURE - 1;
    state.stalled.delete(parentId);
    state.asked.set(parentId, { at: end.index, next: page.next });
    if (state.from === null) {
      state.from = tree.rows.length;
      setAnnouncement(`Loading more in ${label}`);
    }
    setPaused((previous) => {
      if (!previous.has(parentId)) return previous;
      const next = new Set(previous);
      next.delete(parentId);
      return next;
    });
    page.load();
  };
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
  const rowDropHandlers = (item: T, takesInside: boolean) =>
    dragAndDrop
      ? {
          onDragOver: (event: DragEvent<HTMLElement>) => {
            const position = dropPositionFor({
              clientY: event.clientY,
              rect: event.currentTarget.getBoundingClientRect(),
              allowInside:
                takesInside &&
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
                    allowInside: takesInside,
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
      {/* The scroller holds the tree and, beside it rather than inside it,
          each branch end's controls (Retry, Show more): a tree owns only
          its items. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: the scroller only listens; keys act on the focused treeitem inside, and wheel or presses only allow reads. */}
      <div
        ref={viewport}
        data-tree-viewport=""
        className={className}
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
        onWheel={allowReads}
        onTouchMove={allowReads}
        onPointerDown={(event) => {
          // Show more and Retry read on their click; their press must not
          // swap them away from under the pointer first.
          if (
            !(event.target instanceof Element) ||
            !event.target.closest("[data-tree-end]")
          )
            allowReads();
        }}
        onFocus={(event) => {
          const target = event.target;
          const row =
            target instanceof HTMLElement
              ? target.closest<HTMLElement>("[data-tree-id]")?.dataset.treeId
              : undefined;
          holdsFocus.current = true;
          // Focus that reached a row another way (a click, a host) is where
          // the arrows go on from: the roving row follows it.
          if (row && row !== focusedId) {
            lastFocused.current = row;
            setFocusedId(row);
          }
          const id =
            target instanceof HTMLElement && target.matches(":focus-visible")
              ? row
              : undefined;
          setRing((current) =>
            id ? { id, glide: current !== null && current.id !== id } : null,
          );
        }}
        onBlur={(event) => {
          if (
            event.relatedTarget instanceof Node &&
            event.currentTarget.contains(event.relatedTarget)
          )
            return;
          // A focused row taken away leaves focus to its neighbour.
          if (!(event.target instanceof Node) || event.target.isConnected)
            holdsFocus.current = false;
          setRing(null);
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
          // A key on a row: the tree holds focus.
          holdsFocus.current = true;
          const children = tree.children.get(row.id) ?? [];
          const item = byId.get(row.id);
          let next: string | undefined;
          switch (event.key) {
            case "ArrowDown":
            case "ArrowUp": {
              const down = event.key === "ArrowDown";
              const slot = layout.indexById.get(row.id);
              // Past an end with nothing more to load there, a host may go
              // on to the list beside this one (onTreeLeave).
              if (down ? slot === layout.slots.length - 1 : slot === 0)
                viewport.current?.dispatchEvent(
                  new CustomEvent(TREE_LEAVE_EVENT, {
                    bubbles: true,
                    cancelable: true,
                    detail: { direction: down ? "down" : "up" },
                  }),
                );
              next =
                tree.rows[
                  down
                    ? Math.min(tree.rows.length - 1, index + 1)
                    : Math.max(0, index - 1)
                ]?.id;
              break;
            }
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
          if (next) {
            setFocusedId(next);
            allowReads();
          }
        }}
      >
        <div
          style={{
            height: contentHeight,
            position: "relative",
            transition: slide && `height ${slide}`,
          }}
        >
          <div
            role="tree"
            aria-label={label}
            data-drop-root={drop?.id === null ? drop.position : undefined}
            data-dragging={draggingId ? "true" : undefined}
            style={{ position: "absolute", inset: 0 }}
          >
            {(() => {
              // The keyboard's ring, on the focused row's own (indented) box.
              const index = ring ? layout.indexById.get(ring.id) : undefined;
              const slot =
                index === undefined ? undefined : layout.slots[index];
              if (index === undefined || slot?.kind !== "row") return null;
              return (
                <div
                  aria-hidden="true"
                  data-tree-focus=""
                  data-glide={ring?.glide ? "" : undefined}
                  // Gliding between rows, the ring takes the glide; done,
                  // it rides its row's own slide when rows move under it.
                  onTransitionEnd={() =>
                    setRing((current) =>
                      current?.glide ? { ...current, glide: false } : current,
                    )
                  }
                  style={{
                    position: "absolute",
                    top: index * rowHeight,
                    left: slot.row.depth * indent,
                    right: 0,
                    height: rowHeight,
                    pointerEvents: "none",
                    transition: ring?.glide
                      ? undefined
                      : slide && `top ${slide}`,
                    // Above the rows, the focused one included (hosts lift
                    // it), so a highlighted row never covers it.
                    zIndex: 2,
                  }}
                />
              );
            })()}
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
              ]),
            ]
              .sort((a, b) => a - b)
              .map((index) => ({ slot: layout.slots[index], index }))
              .map(({ slot, index }) => {
                if (!slot) return null;
                // Retry and Show more sit beside the tree (below).
                if (slot.kind === "error" || slot.kind === "paused")
                  return null;
                if (slot.kind === "placeholder") {
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
                    {...rowDropHandlers(
                      item,
                      hasChildren || Boolean(item.acceptsChildren),
                    )}
                    aria-level={row.depth + 1}
                    aria-posinset={row.position}
                    // -1: more siblings exist than are loaded (ARIA 1.2).
                    aria-setsize={more?.has(row.parentId) ? -1 : row.siblings}
                    aria-expanded={
                      hasChildren ? expanded.has(row.id) : undefined
                    }
                    aria-selected={
                      selectedId ? selectedId === row.id : undefined
                    }
                    tabIndex={
                      row.id === (focusedId ?? selectedId ?? tree.rows[0]?.id)
                        ? 0
                        : -1
                    }
                    style={{
                      position: "absolute",
                      top: index * rowHeight,
                      height: rowHeight,
                      left: row.depth * indent,
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
              if (
                !leaving ||
                slot.kind !== "placeholder" ||
                top === undefined ||
                !onScreen.current.has(key)
              )
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
                    left: placed.depth * indent,
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
          {layout.slots.map((slot, index) => {
            if (slot.kind !== "error" && slot.kind !== "paused") return null;
            pseudoPlacements.current.set(slot.key, index * rowHeight);
            return (
              <TreeEnd
                key={slot.key}
                slot={slot}
                label={label}
                top={index * rowHeight}
                rowHeight={rowHeight}
                slide={slide}
                className={
                  pseudoMotion.find((entry) => entry.key === slot.key)?.entering
                    ? (motionClasses?.enter ?? "cat-row-enter")
                    : undefined
                }
                onRead={() => readNow(slot.parentId)}
              />
            );
          })}
          {pseudoMotion.map(({ key, item: slot, exiting: leaving }) => {
            const top = pseudoPlacements.current.get(key);
            if (
              !leaving ||
              (slot.kind !== "error" && slot.kind !== "paused") ||
              top === undefined
            )
              return null;
            return (
              <TreeEnd
                key={`exiting:${key}`}
                slot={slot}
                label={label}
                top={top}
                rowHeight={rowHeight}
                className={motionClasses?.exit ?? "cat-row-exit"}
                leaving
              />
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
 * A still placeholder row, shaped like the section skeleton, holding a
 * paginated branch's end. It slides with the rows when a branch above it
 * opens or a row arrives at the top; when a page lands above it, it jumps
 * to the new end at once, so it never sweeps across the arriving rows.
 */
function TreePseudoRow({
  slot,
  top,
  rowHeight,
  slide,
  className,
  leaving = false,
}: {
  slot: Extract<TreePseudoSlot, { kind: "placeholder" }>;
  top: number;
  rowHeight: number;
  slide?: string;
  className?: string;
  leaving?: boolean;
}) {
  const previous = useRef(top);
  const jumped =
    Math.abs(top - previous.current) > rowHeight * PLACEHOLDER_ROWS;
  useEffect(() => {
    previous.current = top;
  });
  return (
    <div
      aria-hidden="true"
      data-tree-more="placeholder"
      className={className}
      style={{
        position: "absolute",
        top,
        height: rowHeight,
        left: 0,
        right: 0,
        transition: slide && !leaving && !jumped ? `top ${slide}` : undefined,
        paddingInlineStart: 8 + slot.depth * 14,
      }}
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

/**
 * A branch end the person acts on, beside the tree: the failed read with
 * Retry, or Show more where the tree stopped reading on its own.
 */
function TreeEnd({
  slot,
  label,
  top,
  rowHeight,
  slide,
  className,
  leaving = false,
  onRead,
}: {
  slot: Extract<TreePseudoSlot, { kind: "error" | "paused" }>;
  label: string;
  top: number;
  rowHeight: number;
  slide?: string;
  className?: string;
  leaving?: boolean;
  onRead?: () => void;
}) {
  return (
    <div
      role={slot.kind === "error" && !leaving ? "alert" : undefined}
      aria-hidden={leaving || undefined}
      inert={leaving || undefined}
      data-tree-more={slot.kind}
      data-tree-end=""
      className={className}
      style={{
        position: "absolute",
        top,
        height: rowHeight,
        left: 0,
        right: 0,
        transition: slide && !leaving ? `top ${slide}` : undefined,
        paddingInlineStart: 8 + slot.depth * 14,
      }}
    >
      {slot.kind === "error" ? (
        <>
          <span>{slot.error}</span>
          <button type="button" onClick={onRead}>
            Retry
          </button>
        </>
      ) : (
        <button
          type="button"
          aria-label={`Show more in ${label}`}
          onClick={onRead}
        >
          Show more
        </button>
      )}
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
  tail,
  dragAndDrop,
  initiallyExpanded,
  className,
  onViewport,
  indent,
}: {
  dragAndDrop?: TreeDragAndDrop<T>;
  /** Class for the scroller (see `Tree`). */
  className?: string;
  /** Called with the scroller once mounted (see `Tree`). */
  onViewport?: (viewport: HTMLDivElement) => (() => void) | undefined;
  /** How far each level of depth sets a row in (see `Tree`). */
  indent?: number;
  /**
   * Whether a row with children starts open the first time it loads
   * (default: closed). Later toggles are the person's.
   */
  initiallyExpanded?: (item: T) => boolean;
  /**
   * Root items known to come after the unloaded rows (an open item older
   * than everything loaded), shown past the root's end until a page brings
   * them in. See `Tree`'s `tail`.
   */
  tail?: readonly T[];
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
  // Rows already seen keep whatever the person chose for them.
  const seen = useRef(new Set<string>());
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
  useEffect(() => {
    if (!initiallyExpanded) return;
    const opened = items.filter(
      (item) =>
        !seen.current.has(item.id) &&
        item.hasChildren &&
        initiallyExpanded(item),
    );
    // A row seen only childless still opens when its first children come.
    for (const item of items) if (item.hasChildren) seen.current.add(item.id);
    if (opened.length)
      setExpanded(
        (current) => new Set([...current, ...opened.map((item) => item.id)]),
      );
  }, [items, initiallyExpanded]);
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
  const tailById = useMemo(
    () => new Map((tail ?? []).map((item) => [item.id, item])),
    [tail],
  );
  const tailEntries = useMemo(() => {
    const roots = new Set(root.ids);
    return (tail ?? [])
      .filter((item) => !roots.has(item.id))
      .map((item) => ({
        ...item,
        parentId: null,
        hasChildren: false,
        itemId: item.id,
      }));
  }, [tail, root]);
  const itemFor = (id: string) => collection.getItem(id) ?? tailById.get(id);
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
          next: branch.cursor,
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
        className={className}
        onViewport={onViewport}
        indent={indent}
        height={height}
        rowHeight={rowHeight}
        selectedId={selectedId}
        motionClasses={motionClasses}
        expanded={expanded}
        onExpandedChange={setExpanded}
        more={more}
        tail={tailEntries}
        dragAndDrop={
          dragAndDrop
            ? {
                drag: (entry) => {
                  const source = "itemId" in entry && itemFor(entry.itemId);
                  return source ? (dragAndDrop.drag?.(source) ?? null) : null;
                },
                accept: (types, target) =>
                  dragAndDrop.accept(types, {
                    item:
                      target.item && "itemId" in target.item
                        ? (itemFor(target.item.itemId) ?? null)
                        : null,
                    position: target.position,
                  }),
                onDrop: (transfer, target) =>
                  dragAndDrop.onDrop(transfer, {
                    item:
                      target.item && "itemId" in target.item
                        ? (itemFor(target.item.itemId) ?? null)
                        : null,
                    position: target.position,
                  }),
                onDragStart: (entry) => {
                  const source = "itemId" in entry && itemFor(entry.itemId);
                  if (source) dragAndDrop.onDragStart?.(source);
                },
                onDragEnd: () => dragAndDrop.onDragEnd?.(),
              }
            : undefined
        }
        renderItem={(item, context) =>
          "itemId" in item ? (
            <CollectionRow
              collection={collection}
              id={item.itemId}
              fallback={tailById.get(item.itemId)}
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
  fallback,
  context,
  renderItem,
}: {
  collection: Collection<T>;
  id: string;
  /** A tail row, not in the collection (yet). */
  fallback?: T;
  context: TreeRenderContext;
  renderItem: (item: T, context: TreeRenderContext) => ReactNode;
}) {
  const item = useCollectionItem({ collection, id }) ?? fallback;
  const last = useRef(item);
  if (item) last.current = item;
  return last.current ? renderItem(last.current, context) : null;
}
