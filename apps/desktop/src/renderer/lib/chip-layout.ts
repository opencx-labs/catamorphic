/**
 * How chips wrap above a composer (ADR 0239): compact chips flow in lines,
 * a wide chip takes a line of its own, and nothing scrolls sideways. Past
 * a few lines the rest fold behind an "N more" chip at the end of the last
 * line shown. Pure, so the rail and its tests agree on where lines break.
 */

/** One chip's natural width, and whether it spans its line. */
export interface ChipBox {
  width: number;
  wide: boolean;
}

/** Lines the boxes take in a rail `width` wide, `gap` apart. */
export function chipLines({
  boxes,
  width,
  gap,
}: {
  boxes: readonly ChipBox[];
  width: number;
  gap: number;
}): number {
  let lines = 0;
  let used = 0;
  for (const box of boxes) {
    if (box.wide) {
      lines += 1;
      used = width + 1;
      continue;
    }
    // Sub-pixel widths round the same way the browser lays them out.
    if (used > 0 && used + gap + box.width <= width + 0.5)
      used += gap + box.width;
    else {
      lines += 1;
      used = box.width;
    }
  }
  return lines;
}

/**
 * How many chips show while the rail is folded: all of them when they fit
 * in `maxLines`, else as many as fit with the "N more" chip after them.
 * At least one shows, so the rail never folds to nothing but its button.
 */
export function shownChipCount({
  boxes,
  width,
  gap,
  maxLines,
  moreWidth,
}: {
  boxes: readonly ChipBox[];
  width: number;
  gap: number;
  maxLines: number;
  moreWidth: number;
}): number {
  if (width <= 0 || chipLines({ boxes, width, gap }) <= maxLines)
    return boxes.length;
  const more: ChipBox = { width: moreWidth, wide: false };
  for (let count = boxes.length - 1; count > 1; count -= 1)
    if (
      chipLines({ boxes: [...boxes.slice(0, count), more], width, gap }) <=
      maxLines
    )
      return count;
  return Math.min(1, boxes.length);
}
