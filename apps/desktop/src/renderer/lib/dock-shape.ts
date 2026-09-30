/** A window-relative rectangle of the detached dock's drawn content. */
export interface DockShapeRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** How far drawing reaches past an element's box on each side. */
export interface DockShapeReach {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Focus rings and hairline outlines draw just outside a box. */
const OUTLINE_REACH = 4;
/** Past this many rectangles the window stays whole rather than shaped. */
const MAX_SHAPE_RECTS = 64;

/**
 * How far a computed `box-shadow` visibly draws past its box: each outer
 * shadow reaches half its blur plus its spread, shifted by its offset.
 * A CSS blur radius is two standard deviations, so half of it is where the
 * shadow has faded to a sixth of its strength (under 4% alpha for the
 * chat's shadow-2xl); the fainter outer half is clipped. The full extent
 * (about 64 px below and 38 px beside an open chat) would cover the whole
 * margin the dock window keeps around the chat, and the dock would swallow
 * every click there again. Inset shadows draw inside. Computed values list
 * the color first, then lengths in px.
 */
export function shadowReach(boxShadow: string): DockShapeReach {
  const reach = { left: 0, top: 0, right: 0, bottom: 0 };
  if (!boxShadow || boxShadow === "none") return reach;
  // Split on commas outside parentheses (colors carry their own commas).
  const shadows: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < boxShadow.length; index++) {
    const char = boxShadow[index];
    if (char === "(") depth++;
    else if (char === ")") depth--;
    else if (char === "," && depth === 0) {
      shadows.push(boxShadow.slice(start, index));
      start = index + 1;
    }
  }
  shadows.push(boxShadow.slice(start));
  for (const shadow of shadows) {
    if (/\binset\b/.test(shadow)) continue;
    const lengths = [
      ...shadow.replace(/\([^)]*\)/g, "").matchAll(/(-?[\d.]+)px/g),
    ].map((match) => Number(match[1]));
    const [x = 0, y = 0, blur = 0, spread = 0] = lengths;
    const extent = Math.max(0, blur / 2 + spread);
    reach.left = Math.max(reach.left, extent - x);
    reach.right = Math.max(reach.right, extent + x);
    reach.top = Math.max(reach.top, extent - y);
    reach.bottom = Math.max(reach.bottom, extent + y);
  }
  return reach;
}

const clips = (style: CSSStyleDeclaration) =>
  style.overflowX !== "visible" && style.overflowY !== "visible";

const contains = (outer: DOMRect, inner: DOMRect) =>
  inner.left >= outer.left &&
  inner.top >= outer.top &&
  inner.right <= outer.right &&
  inner.bottom <= outer.bottom;

/**
 * Where the detached dock draws, as window rectangles in CSS pixels, each
 * grown by its shadow's reach. Drawn content is what takes the pointer
 * (the app root and the body are pointer-transparent, so a
 * `pointer-events: none` element is only a container), what is animating
 * (an exiting chat gives up the pointer on its first frame but draws until
 * the exit ends), and tooltips, which draw without taking it. A clipping
 * element bounds everything inside it, so a chat's transcript costs one
 * rectangle, not one per message. `onDrawn` sees every drawn element (to
 * watch its size). Null means too much is drawn to shape: keep the whole
 * window.
 */
export function drawnDockRects(
  root: Element,
  onDrawn?: (element: Element) => void,
): DockShapeRect[] | null {
  const found: { rect: DOMRect; reach: DockShapeReach }[] = [];
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
    const drawn =
      style.pointerEvents !== "none" ||
      element.getAttribute("role") === "tooltip" ||
      element
        .getAnimations()
        .some((animation) => animation.playState === "running");
    let bound = within;
    if (drawn && rect.width > 0 && rect.height > 0) {
      onDrawn?.(element);
      const reach = shadowReach(style.boxShadow);
      if (!within || !contains(within, rect) || reach.bottom > 0)
        found.push({ rect, reach });
      bound = within && contains(within, rect) ? within : rect;
      if (clips(style)) return;
    }
    for (const child of element.children) visit(child, bound);
  };
  for (const child of root.children) visit(child, null);
  if (found.length > MAX_SHAPE_RECTS) return null;
  return found.map(({ rect, reach }) => {
    const x = Math.max(
      0,
      Math.floor(rect.left - Math.max(reach.left, OUTLINE_REACH)),
    );
    const y = Math.max(
      0,
      Math.floor(rect.top - Math.max(reach.top, OUTLINE_REACH)),
    );
    return {
      x,
      y,
      width: Math.ceil(rect.right + Math.max(reach.right, OUTLINE_REACH)) - x,
      height:
        Math.ceil(rect.bottom + Math.max(reach.bottom, OUTLINE_REACH)) - y,
    };
  });
}
