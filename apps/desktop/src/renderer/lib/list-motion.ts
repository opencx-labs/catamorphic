import { type RefObject, useLayoutEffect, useRef } from "react";

/**
 * Motion for search-like lists (the palette, connector search, anything
 * that re-filters as you type). Filtering removes rows from the MIDDLE, so
 * without help survivors teleport up to fill holes and only the bottom gap
 * animates — a snap even when the container's height tweens. Instead:
 *
 * - Surviving rows FLIP: their old→new offset is played as a translate
 *   easing to zero (both axes, so a wrapping grid of tiles works too) (a keystroke mid-glide continues from the in-flight
 *   position, never teleports backwards).
 * - Rows the previous set didn't have fade-rise in.
 * - Reduced-motion users get the same filtering with no transforms or fades.
 *
 * Rows are the direct children of `sizerRef` that carry `data-item-id`;
 * anything without an id (group labels) is ignored. Reads happen before
 * writes — interleaving offsetTop with style writes reflows per row.
 * Motion is on the standard curve at 200ms (see DESIGN.md's contract).
 */
export function useListMotion(
  sizerRef: RefObject<HTMLElement | null>,
  /** Recomputed (and rows animated) whenever this changes. */
  key: unknown,
  opts: {
    /**
     * Whether rows in the very first pass fade-rise in. The palette skips
     * it (its panel's own enter covers that paint); a list that fills in
     * asynchronously after its container opened wants it.
     */
    enterOnFirstPass?: boolean;
    /** Extra transitions to keep alive while a row glides (colors, etc.). */
    keepTransitions?: string;
  } = {},
): {
  /** Forget row positions — the next pass is a fresh first paint (call
   * when the list's container closes, so reopening doesn't glide stale
   * rows). */
  reset: () => void;
} {
  const rowTopsRef = useRef(new Map<string, { top: number; left: number }>());
  const { enterOnFirstPass = false, keepTransitions = "" } = opts;
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measures on the keys list only; options are read on each pass
  useLayoutEffect(() => {
    const sizer = sizerRef.current;
    if (!sizer) return;
    const reducedMotion = window.matchMedia?.(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    const previousTops = rowTopsRef.current;
    // Offsets relative to the list itself, so a section above changing
    // height moves nothing here.
    const origin = sizer.getBoundingClientRect();
    const firstPass = previousTops.size === 0;
    const nextTops = new Map<string, { top: number; left: number }>();
    const rows: {
      row: HTMLElement;
      dx: number;
      dy: number;
      entering: boolean;
    }[] = [];
    for (const node of sizer.children) {
      const row = node as HTMLElement;
      const id = row.dataset.itemId;
      if (!id) continue;
      const matrix = new DOMMatrixReadOnly(getComputedStyle(row).transform);
      const rect = row.getBoundingClientRect();
      const top = rect.top - origin.top + sizer.scrollTop - matrix.m42;
      const left = rect.left - origin.left + sizer.scrollLeft - matrix.m41;
      nextTops.set(id, { top, left });
      const before = previousTops.get(id);
      if (before === undefined) {
        rows.push({
          row,
          dx: 0,
          dy: 0,
          entering: !firstPass || enterOnFirstPass,
        });
        continue;
      }
      rows.push({
        row,
        dx: Math.round(before.left + matrix.m41 - left),
        dy: Math.round(before.top + matrix.m42 - top),
        entering: false,
      });
    }
    rowTopsRef.current = nextTops;
    if (reducedMotion) {
      for (const { row } of rows) {
        row.style.transition = "";
        row.style.transform = "";
        row.style.opacity = "";
      }
      return;
    }
    for (const { row, dx, dy, entering } of rows) {
      if (dx || dy) {
        row.style.transition = "none";
        row.style.transform = `translate(${dx}px, ${dy}px)`;
      } else if (entering) {
        row.style.transition = "none";
        row.style.transform = "translateY(4px)";
        row.style.opacity = "0";
      } else {
        row.style.transition = "";
        row.style.transform = "";
        row.style.opacity = "";
      }
    }
    if (!rows.some(({ dx, dy, entering }) => dx || dy || entering)) return;
    const frame = requestAnimationFrame(() => {
      for (const { row, dx, dy, entering } of rows) {
        if (!dx && !dy && !entering) continue;
        row.style.transition = [
          "transform 200ms cubic-bezier(0.2, 0, 0, 1)",
          "opacity 200ms cubic-bezier(0.2, 0, 0, 1)",
          keepTransitions,
        ]
          .filter(Boolean)
          .join(", ");
        row.style.transform = "";
        row.style.opacity = "";
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [key]);
  // A resized list (a wider sidebar reflowing a tile grid) re-takes its
  // positions without animating, so the next change starts from the truth.
  useLayoutEffect(() => {
    const sizer = sizerRef.current;
    if (!sizer || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (rowTopsRef.current.size === 0) return;
      const origin = sizer.getBoundingClientRect();
      const tops = new Map<string, { top: number; left: number }>();
      for (const node of sizer.children) {
        const row = node as HTMLElement;
        const id = row.dataset.itemId;
        if (!id) continue;
        const rect = row.getBoundingClientRect();
        const matrix = new DOMMatrixReadOnly(getComputedStyle(row).transform);
        tops.set(id, {
          top: rect.top - origin.top + sizer.scrollTop - matrix.m42,
          left: rect.left - origin.left + sizer.scrollLeft - matrix.m41,
        });
      }
      rowTopsRef.current = tops;
    });
    observer.observe(sizer);
    return () => observer.disconnect();
  }, [sizerRef]);
  return { reset: () => rowTopsRef.current.clear() };
}
