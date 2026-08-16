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
