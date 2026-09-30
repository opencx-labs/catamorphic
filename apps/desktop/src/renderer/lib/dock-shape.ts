/** A window-relative rectangle of the detached dock's drawn content. */
export interface DockShapeRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Linux cannot let clicks through a window and keep telling it where the
 * pointer is (the main process explains); there the dock's window takes the
 * shape of what it draws instead, so its empty space belongs to the screen.
 */
export const DOCK_WINDOW_SHAPED =
  typeof navigator !== "undefined" && /Linux/.test(navigator.platform);

/** Room for shadows and focus rings around drawn content. */
const SHAPE_PADDING = 8;
/** Past this many rectangles the window stays whole rather than shaped. */
const MAX_SHAPE_RECTS = 64;

const clips = (style: CSSStyleDeclaration) =>
  style.overflowX !== "visible" && style.overflowY !== "visible";

const contains = (outer: DOMRect, inner: DOMRect) =>
  inner.left >= outer.left &&
  inner.top >= outer.top &&
  inner.right <= outer.right &&
  inner.bottom <= outer.bottom;

/**
 * Where the detached dock draws, as window rectangles: content that takes
 * the pointer (the app root and the body are pointer-transparent, so a
 * `pointer-events: none` element is only a container) and tooltips, which
 * draw without taking it. A clipping element bounds everything inside it,
 * so a chat's transcript costs one rectangle, not one per message. Null
 * means too much is drawn to shape: keep the whole window.
 */
export function drawnDockRects(root: Element): DockShapeRect[] | null {
  const found: DOMRect[] = [];
  const visit = (element: Element, within: DOMRect | null) => {
    const style = getComputedStyle(element);
    // Nothing inside a transparent element draws either.
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      Number(style.opacity) === 0
    )
      return;
    const rect = element.getBoundingClientRect();
    const painted =
      element.getAttribute("role") === "tooltip" ||
      style.pointerEvents !== "none";
    let bound = within;
    if (painted && rect.width > 0 && rect.height > 0) {
      if (!within || !contains(within, rect)) found.push(rect);
      bound = within && contains(within, rect) ? within : rect;
      if (clips(style)) return;
    }
    for (const child of element.children) visit(child, bound);
  };
  for (const child of root.children) visit(child, null);
  if (found.length > MAX_SHAPE_RECTS) return null;
  return found.map((rect) => {
    const x = Math.max(0, Math.floor(rect.left - SHAPE_PADDING));
    const y = Math.max(0, Math.floor(rect.top - SHAPE_PADDING));
    return {
      x,
      y,
      width: Math.ceil(rect.right + SHAPE_PADDING) - x,
      height: Math.ceil(rect.bottom + SHAPE_PADDING) - y,
    };
  });
}
