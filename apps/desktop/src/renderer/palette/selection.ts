/**
 * The palette's highlight: a row position and, once the keyboard or a
 * moving pointer chose a row, that row. Late sources re-rank the list
 * under the highlight; it stays on the chosen row rather than on its old
 * position, so Enter opens the row the person saw highlighted.
 */
export interface PaletteSelection {
  index: number;
  /** The chosen row's id; null follows whatever ranks at the position. */
  id: string | null;
}

/** A fresh query or mode: the top result leads, whatever it becomes. */
export const TOP_ROW: PaletteSelection = { index: 0, id: null };

/** The highlighted row: the chosen one wherever it ranks now, else the position. */
export function highlightedRow(
  selection: PaletteSelection,
  rows: readonly { id: string }[],
): number {
  const chosen =
    selection.id === null
      ? -1
      : rows.findIndex((row) => row.id === selection.id);
  return chosen >= 0
    ? chosen
    : Math.min(selection.index, Math.max(rows.length - 1, 0));
}

/** Arrow keys choose the neighbor of the row highlighted now. */
export function moveHighlight(
  selection: PaletteSelection,
  rows: readonly { id: string }[],
  delta: number,
): PaletteSelection {
  const index = Math.min(
    Math.max(highlightedRow(selection, rows) + delta, 0),
    rows.length - 1,
  );
  return { index, id: rows[index]?.id ?? null };
}
