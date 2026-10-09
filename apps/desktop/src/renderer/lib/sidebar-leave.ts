import type { SidebarSide } from "../../shared/sidebar.js";
import { EASE_STANDARD, motionMs, prefersReducedMotion } from "./motion.js";

/** How long an item takes to leave. */
const LEAVE_MS = 160;
/** The sweep from the top row to the last, however many rows show. */
const SWEEP_MS = 60;
/** How far a part of a row without text (an icon, a control) steps out. */
const STEP_PX = 10;
/** Pieces of a row closer than this leave together. */
const GAP_PX = 16;
/** Names the leave's animations among a row's own. */
export const LEAVE_ID = "sidebar-leave";
/** Boxes that leave whole and draw no thread: icons, images, controls. */
const BOXES =
  "svg, img, picture, canvas, video, iframe, input, textarea, select";

/** Something on screen that leaves: a run of text, or a box. */
interface Piece {
  element: HTMLElement | SVGElement;
  /** Each line of the text, or the box. */
  lines: DOMRect[];
  text: boolean;
}

export interface SidebarLeave {
  /** Leave (true) or come back (false), from wherever the items are. */
  leaving: (on: boolean) => void;
  /** Put every item back at once. */
  cancel: () => void;
}

/**
 * A closing sidebar's items leave before it does (ADR 0200, amended
 * 2026-10-09). What shows on each row (an icon, a label, its description)
 * leaves together toward the edge the sidebar goes to and fades, in a
 * sweep from the top. A row with text travels its own length and draws a
 * thread behind it, a hairline in the text's color that grows from where
 * the row ended in step with it, so the thread spans where the row was and
 * never crosses it. The panel follows a beat later (styles.css) and carries
 * the threads away. Opening again mid-close plays it all back from where it
 * is.
 *
 * Measured once, on the click; the motion is Web Animations on
 * `translate`, `opacity` and the threads' `scale`. Nothing runs under
 * reduced motion or in a workspace that isn't showing.
 */
export function leaveSidebar({
  panel,
  side,
  onReturned,
}: {
  panel: HTMLElement;
  side: SidebarSide;
  /** Every item is back in place after `leaving(false)`. */
  onReturned: () => void;
}): SidebarLeave | undefined {
  if (prefersReducedMotion() || !shown(panel)) return undefined;
  const box = panel.getBoundingClientRect();
  const onScreen = (rect: DOMRect) =>
    rect.bottom > box.top &&
    rect.top < box.bottom &&
    (rect.width > 0 || rect.height > 0);
  const big = (rect: DOMRect | undefined): rect is DOMRect =>
    rect !== undefined && rect.width >= 2 && rect.height >= 2;
  // What clips an element on screen: the panel and every box between that
  // clips its overflow (a scrolled list, a truncated label).
  const clips = new Map<Element, DOMRect[]>();
  const clipsOf = (element: Element): DOMRect[] => {
    const known = clips.get(element);
    if (known) return known;
    const parent = element.parentElement;
    const outer = !parent || parent === panel ? [box] : clipsOf(parent);
    const style = getComputedStyle(element);
    const own =
      style.overflowX === "visible" && style.overflowY === "visible"
        ? outer
        : [...outer, element.getBoundingClientRect()];
    clips.set(element, own);
    return own;
  };

  const pieces = new Map<Element, Piece>();
  const walker = document.createTreeWalker(panel, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.textContent?.trim()) continue;
    // Off screen (scrolled away, a hidden tab): skipped before any style
    // is read, so a long list costs only what shows.
    const near = node.parentElement?.getBoundingClientRect();
    if (!near || !onScreen(near)) continue;
    const element = movable({ element: node.parentElement, panel });
    if (!element || !shown(element)) continue;
    const bounds = clipsOf(element);
    range.selectNodeContents(node);
    for (const line of range.getClientRects()) {
      const rect = intersect({ rect: line, bounds });
      if (!big(rect)) continue;
      const piece = pieces.get(element) ?? { element, lines: [], text: true };
      addLine({ lines: piece.lines, rect });
      pieces.set(element, piece);
    }
  }
  for (const element of panel.querySelectorAll<HTMLElement | SVGElement>(
    BOXES,
  )) {
    if (element.parentElement?.closest("svg") || pieces.has(element)) continue;
    const near = element.getBoundingClientRect();
    if (!onScreen(near) || !shown(element)) continue;
    const rect = intersect({ rect: near, bounds: clipsOf(element) });
    if (big(rect)) pieces.set(element, { element, lines: [rect], text: false });
  }
  // A piece inside another moves with it; its text joins the outer lines.
  for (const [element, piece] of pieces) {
    const outer = outerPiece({ element, pieces, panel });
    if (!outer) continue;
    if (piece.text) {
      for (const rect of piece.lines) addLine({ lines: outer.lines, rect });
      outer.text = true;
    }
    pieces.delete(element);
  }

  const traces = document.createElement("div");
  traces.className = "sidebar-traces";
  traces.setAttribute("aria-hidden", "true");
  const animations: Animation[] = [];
  const toward = side === "left" ? -1 : 1;
  for (const group of clusters([...pieces.values()])) {
    const rects = group.flatMap((piece) => piece.lines);
    const left = Math.min(...rects.map((rect) => rect.left));
    const right = Math.max(...rects.map((rect) => rect.right));
    const top = Math.min(...rects.map((rect) => rect.top));
    const texts = group.filter((piece) => piece.text);
    const distance = texts.length > 0 ? right - left : STEP_PX;
    const timing: KeyframeAnimationOptions = {
      duration: motionMs(LEAVE_MS),
      delay: Math.round(
        Math.max(0, Math.min(1, (top - box.top) / box.height)) * SWEEP_MS,
      ),
      easing: EASE_STANDARD,
      fill: "both",
      id: LEAVE_ID,
    };
    for (const piece of group)
      animations.push(
        piece.element.animate(
          { translate: `${toward * distance}px 0`, opacity: 0 },
          timing,
        ),
      );
    // A wrapped paragraph leaves a thread per line; a row, one across it.
    const [main] = texts;
    const [first] = main?.lines ?? [];
    if (!main || !first) continue;
    const threads =
      group.length === 1
        ? main.lines
        : [new DOMRect(left, first.top, right - left, first.height)];
    const color = getComputedStyle(main.element).color;
    for (const line of threads) {
      const thread = document.createElement("div");
      thread.className = "sidebar-trace";
      thread.style.cssText = [
        `left: ${line.left - box.left}px`,
        `top: ${Math.round(line.top - box.top + line.height / 2)}px`,
        `width: ${line.width}px`,
        `--trace-color: ${color}`,
      ].join("; ");
      traces.append(thread);
      animations.push(
        thread.animate([{ scale: "0 1" }, { scale: "1 1" }], timing),
      );
    }
  }
  panel.append(traces);

  const cancel = () => {
    for (const animation of animations) animation.cancel();
    traces.remove();
  };
  let leaving = true;
  return {
    leaving: (on) => {
      if (on === leaving) return;
      leaving = on;
      for (const animation of animations) animation.reverse();
      if (on) return;
      Promise.all(animations.map((animation) => animation.finished)).then(
        () => {
          if (leaving) return;
          cancel();
          onReturned();
        },
        // Cancelled: whoever cancelled has cleaned up.
        () => {},
      );
    },
    cancel,
  };
}

/** Drawn and seen: not hidden, and not see-through (a row's hover actions). */
function shown(element: Element): boolean {
  // jsdom has no checkVisibility; there is nothing to see there anyway.
  if (typeof element.checkVisibility !== "function") return true;
  return element.checkVisibility({
    checkOpacity: true,
    checkVisibilityCSS: true,
  });
}

/** The closest box a transform moves: inline boxes and `contents` do not. */
function movable({
  element,
  panel,
}: {
  element: Element | null;
  panel: HTMLElement;
}): HTMLElement | SVGElement | undefined {
  for (
    let current = element;
    current && current !== panel;
    current = current.parentElement
  ) {
    const display = getComputedStyle(current).display;
    if (
      display !== "inline" &&
      display !== "contents" &&
      (current instanceof HTMLElement || current instanceof SVGElement)
    )
      return current;
  }
  return undefined;
}

/** The outermost piece holding an element, if any. */
function outerPiece({
  element,
  pieces,
  panel,
}: {
  element: Element;
  pieces: ReadonlyMap<Element, Piece>;
  panel: HTMLElement;
}): Piece | undefined {
  let outer: Piece | undefined;
  for (
    let current = element.parentElement;
    current && current !== panel;
    current = current.parentElement
  )
    outer = pieces.get(current) ?? outer;
  return outer;
}

/** Adds a line of text, joining a line it shares a row with. */
function addLine({ lines, rect }: { lines: DOMRect[]; rect: DOMRect }): void {
  const same = lines.findIndex((line) => sameRow({ a: line, b: rect }));
  const known = lines[same];
  if (known) lines[same] = union({ a: known, b: rect });
  else lines.push(rect);
}

/**
 * The pieces that leave together: what shares a row and sits close (an
 * icon, its label, a description), and each wrapped paragraph on its own.
 */
function clusters(pieces: Piece[]): Piece[][] {
  const rows: { line: DOMRect; pieces: Piece[] }[] = [];
  const groups: Piece[][] = [];
  for (const piece of pieces) {
    const [line] = piece.lines;
    if (!line) continue;
    if (piece.lines.length > 1) {
      groups.push([piece]);
      continue;
    }
    const row = rows.find((candidate) =>
      sameRow({ a: candidate.line, b: line }),
    );
    if (row) row.pieces.push(piece);
    else rows.push({ line, pieces: [piece] });
  }
  for (const row of rows) {
    const ordered = [...row.pieces].sort(
      (a, b) => (a.lines[0]?.left ?? 0) - (b.lines[0]?.left ?? 0),
    );
    let group: Piece[] = [];
    let right = Number.NEGATIVE_INFINITY;
    for (const piece of ordered) {
      const [line] = piece.lines;
      if (!line) continue;
      if (group.length > 0 && line.left - right > GAP_PX) {
        groups.push(group);
        group = [];
      }
      group.push(piece);
      right = Math.max(right, line.right);
    }
    if (group.length > 0) groups.push(group);
  }
  return groups;
}

/** Two boxes share a row when each one's middle lies within the other. */
function sameRow({ a, b }: { a: DOMRect; b: DOMRect }): boolean {
  const middleA = a.top + a.height / 2;
  const middleB = b.top + b.height / 2;
  return (
    middleA >= b.top &&
    middleA <= b.bottom &&
    middleB >= a.top &&
    middleB <= a.bottom
  );
}

function union({ a, b }: { a: DOMRect; b: DOMRect }): DOMRect {
  const left = Math.min(a.left, b.left);
  const top = Math.min(a.top, b.top);
  return new DOMRect(
    left,
    top,
    Math.max(a.right, b.right) - left,
    Math.max(a.bottom, b.bottom) - top,
  );
}

function intersect({
  rect,
  bounds,
}: {
  rect: DOMRect;
  bounds: readonly DOMRect[];
}): DOMRect | undefined {
  const left = Math.max(rect.left, ...bounds.map((bound) => bound.left));
  const top = Math.max(rect.top, ...bounds.map((bound) => bound.top));
  const right = Math.min(rect.right, ...bounds.map((bound) => bound.right));
  const bottom = Math.min(rect.bottom, ...bounds.map((bound) => bound.bottom));
  return right > left && bottom > top
    ? new DOMRect(left, top, right - left, bottom - top)
    : undefined;
}
