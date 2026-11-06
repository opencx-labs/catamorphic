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

const clamp = (index: number, rows: readonly unknown[]) =>
  Math.max(0, Math.min(index, rows.length - 1));

/** The highlighted row: the chosen one wherever it ranks now, else the position. */
export function highlightedRow(
  selection: PaletteSelection,
  rows: readonly { id: string }[],
): number {
  const chosen =
    selection.id === null
      ? -1
      : rows.findIndex((row) => row.id === selection.id);
  return chosen >= 0 ? chosen : clamp(selection.index, rows);
}

/**
 * The selection after the rows changed: a chosen row that moved keeps the
 * highlight at its new position; one that left the list gives up the
 * choice, so the highlight stays where it is instead of jumping back if
 * that row returns later. Unchanged selections keep their identity.
 */
export function settleSelection(
  selection: PaletteSelection,
  rows: readonly { id: string }[],
): PaletteSelection {
  if (selection.id === null) return selection;
  const chosen = rows.findIndex((row) => row.id === selection.id);
  if (chosen === selection.index) return selection;
  return chosen >= 0
    ? { index: chosen, id: selection.id }
    : { index: clamp(selection.index, rows), id: null };
}

/** Arrow keys choose the neighbor of the row highlighted now. */
export function moveHighlight(
  selection: PaletteSelection,
  rows: readonly { id: string }[],
  delta: number,
): PaletteSelection {
  const index = clamp(highlightedRow(selection, rows) + delta, rows);
  return { index, id: rows[index]?.id ?? null };
}
