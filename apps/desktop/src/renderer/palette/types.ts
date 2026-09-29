import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import type { OpenMode as CommitMode } from "../../shared/open-mode.js";
import type { BuiltinPaletteMode } from "../../shared/palette.js";
import type { PaletteCategory } from "./rank.js";

export interface PaletteItem {
  id: string;
  icon: LucideIcon;
  iconNode?: ReactNode;
  label: string;
  /** Muted inline text, e.g. a URL host or the item's type. */
  detail?: string;
  keywords: string[];
  /** Preformatted chip, e.g. "⌘B". */
  shortcut?: string;
  /**
   * Choice rows: this row IS the active choice (current model/agent/
   * effort). Renders a quiet check + "current" chip on the right, and a
   * "pin-current" list opens with it first (normal ranking while searching).
   */
  current?: boolean;
  /** Web rows saved as bookmarks carry a star at the right edge. */
  bookmarked?: boolean;
  /**
   * Scope label rendered above this row when the previous row carries a
   * different group (e.g. "Project agents" in the agent pickers).
   */
  group?: string;
  /** Unusable rows (invalid project agents): visible, never committable. */
  disabled?: boolean;
  /** Navigate items load something tab-shaped and honor the commit mode. */
  kind: "action" | "navigate";
  /** What the row is, for ranking (ADR 0186). Defaults to command. */
  category?: PaletteCategory;
  /**
   * Usage key: frecency and learned picks. History identities for pages
   * and project resources, `surface:<kind>` for surfaces, else the row's
   * own stable key. Rows without one never learn.
   */
  usage?: string;
  /**
   * How committing behaves. "stay" swaps palette state in place (entering
   * a mode, retrying a load). "answer" answers the active mode's question
   * and puts the palette away. Default: an ordinary commit.
   */
  commit?: "stay" | "answer";
  run: (mode: CommitMode) => void;
}

/**
 * Where a mode's rows come from. "list" rows are ranked by the palette as
 * the user types. "compute" rows are the mode's own answer to the query
 * (input modes, choice lists with custom rows). "load" rows are fetched:
 * once per entry and then ranked (filtered: false), or per query with the
 * source doing the search (filtered: true).
 */
export type PaletteRows =
  | {
      kind: "list";
      items: readonly PaletteItem[];
      /** Unfiltered order: as given, or the current choice first. */
      zero?: "given" | "pin-current";
    }
  | { kind: "compute"; rows: (query: string) => PaletteItem[] }
  | {
      kind: "load";
      /** Changing it reloads (project switch, a new sidebar search). */
      key: string;
      filtered: boolean;
      /** Shown instead of loading while a filtered mode has no query. */
      idle?: string;
      /** Shown when the source returns nothing. */
      empty?: string;
      debounceMs?: number;
      load: (query: string, signal: AbortSignal) => Promise<PaletteLoad>;
    };
export interface PaletteLoad {
  items: PaletteItem[];
  /** A quiet line above the rows, e.g. "Showing the first 80 matches". */
  notice?: string;
}

/**
 * A palette mode: one chip, one question, one list of rows. Built-in
 * modes, choice pickers, sidebar searches and workspace.js modes all take
 * this shape; typed names enter it, Backspace on empty input leaves it.
 */
export interface PaletteMode {
  id: string;
  chip: string;
  icon: LucideIcon;
  placeholder: string;
  /** Typed names, trigger first. Absent: entered only by a command. */
  names?: readonly string[];
  /** The @ list's row. */
  label?: string;
  description?: string;
  rows: PaletteRows;
}

/**
 * Choice modes: a command narrows the palette to one question ("which
 * agent?", "which effort?"). They are ordinary palette modes; picking a row
 * answers the question and puts the palette away.
 */
export type PaletteChoiceMode =
  | "default-agent"
  | "switch-agent"
  | "configure-agent"
  | "effort"
  | "permission-mode"
  | "model";

/** Built-in modes by id, plus the choice modes. */
export type PaletteModeId = BuiltinPaletteMode | PaletteChoiceMode;
/** Open the palette inside a mode (a command run from anywhere, a sidebar search). */
export type PaletteModeRequest = { nonce: string } & (
  | { mode: PaletteModeId }
  | { mode: "section"; label: string; load: () => Promise<PaletteItem[]> }
);
