/**
 * Editor → chat selection channel. Editor screens register a reader for
 * "what does the user have selected right now"; chat surfaces pull it when
 * they open or focus (Cmd+N, Cmd+M, clicking into a chat) and turn it into
 * a text pill. Pull, not push: nothing is captured until a chat asks, and
 * the pill IS the consent UI — the user sees exactly what got attached and
 * can pop it before sending.
 *
 * Only ONE reader is active at a time (the focused editor pane's) — the
 * app swaps it as panes gain focus.
 */

export interface EditorSelection {
  /** Project-relative path of the file. */
  filePath: string;
  text: string;
  /** 1-based inclusive line range, when the editor can tell. */
  startLine?: number;
  endLine?: number;
}

export type SelectionReader = () => EditorSelection | null;

let activeReader: SelectionReader | null = null;

/** Called by an editor pane on mount/focus; returns an unregister. */
export function registerSelectionReader(reader: SelectionReader): () => void {
  activeReader = reader;
  return () => {
    if (activeReader === reader) activeReader = null;
  };
}

/** The current editor selection, if any editor is registered and has one. */
export function readEditorSelection(): EditorSelection | null {
  try {
    return activeReader?.() ?? null;
  } catch {
    return null;
  }
}

/**
 * Copies out of an editor carry their provenance on the clipboard, so a
 * paste into a chat becomes a selection pill (`file.md · 12–24`) rather
 * than anonymous prose — whatever its size. The plain-text/HTML flavors
 * the editor wrote stay untouched, so pasting anywhere else is a normal
 * paste. Custom clipboard types round-trip within Chromium; other apps
 * never see this flavor.
 */
export const SELECTION_CLIPBOARD_TYPE = "text/x-catamorphic-selection";

/** Editor-pane copy handler: adds the selection flavor after the editor's
 * own copy (which already populated + canceled the event) ran. */
export function stampSelectionOnClipboard(event: {
  clipboardData: DataTransfer | null;
}): void {
  const selection = readEditorSelection();
  if (!selection || !event.clipboardData) return;
  try {
    event.clipboardData.setData(
      SELECTION_CLIPBOARD_TYPE,
      JSON.stringify(selection),
    );
  } catch {
    // Read-only DataTransfer (the copy wasn't ours to write): plain copy.
  }
}

/** The selection an editor stamped onto a paste, if any. */
export function selectionFromClipboard(
  data: DataTransfer | null,
): EditorSelection | null {
  const raw = data?.getData(SELECTION_CLIPBOARD_TYPE);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<EditorSelection>;
    if (typeof parsed.filePath !== "string" || typeof parsed.text !== "string")
      return null;
    if (!parsed.text.trim()) return null;
    return {
      filePath: parsed.filePath,
      text: parsed.text,
      ...(typeof parsed.startLine === "number"
        ? { startLine: parsed.startLine }
        : {}),
      ...(typeof parsed.endLine === "number"
        ? { endLine: parsed.endLine }
        : {}),
    };
  } catch {
    return null;
  }
}
