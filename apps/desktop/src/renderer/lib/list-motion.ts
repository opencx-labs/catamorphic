import { type RefObject, useLayoutEffect, useRef } from "react";

/**
 * Motion for search-like lists (the palette, connector search, anything
 * that re-filters as you type). Filtering removes rows from the MIDDLE, so
 * without help survivors teleport up to fill holes and only the bottom gap
 * animates — a snap even when the container's height tweens. Instead:
 *
 * - Surviving rows FLIP: their old→new top delta is played as a translate
 *   easing to zero (a keystroke mid-glide continues from the in-flight
 *   position, never teleports backwards).
 * - Rows the previous set didn't have fade-rise in.
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
  const rowTopsRef = useRef(new Map<string, number>());
  const { enterOnFirstPass = false, keepTransitions = "" } = opts;
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measures on the keys list only; options are read on each pass
  useLayoutEffect(() => {
    const sizer = sizerRef.current;
    if (!sizer) return;
    const previousTops = rowTopsRef.current;
    const firstPass = previousTops.size === 0;
    const nextTops = new Map<string, number>();
    const rows: { row: HTMLElement; delta: number; entering: boolean }[] = [];
    for (const node of sizer.children) {
      const row = node as HTMLElement;
      const id = row.dataset.itemId;
      if (!id) continue;
      const top = row.offsetTop;
      nextTops.set(id, top);
      const before = previousTops.get(id);
      if (before === undefined) {
        rows.push({
          row,
          delta: 0,
          entering: !firstPass || enterOnFirstPass,
        });
        continue;
      }
      const matrix = new DOMMatrixReadOnly(getComputedStyle(row).transform);
      const delta = before + matrix.m42 - top;
      rows.push({ row, delta: Math.round(delta), entering: false });
    }
    rowTopsRef.current = nextTops;
    for (const { row, delta, entering } of rows) {
      if (delta) {
        row.style.transition = "none";
        row.style.transform = `translateY(${delta}px)`;
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
    if (!rows.some(({ delta, entering }) => delta || entering)) return;
    const frame = requestAnimationFrame(() => {
      for (const { row, delta, entering } of rows) {
        if (!delta && !entering) continue;
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
  return { reset: () => rowTopsRef.current.clear() };
}
