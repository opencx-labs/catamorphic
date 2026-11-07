import type { SidebarItem, SidebarTabConfig, SidebarWhen } from "./sidebar.js";

/**
 * The workspace file (`workspace.js`, ADR 0186): what the window offers for
 * this profile or project. Its sidebars and its palette modes are read from
 * one file, layered personal, then project, then profile, then built in.
 */
export interface WorkspaceConfig {
  sidebars: { left: SidebarTabConfig[]; right: SidebarTabConfig[] };
  palette?: { modes: PaletteModeConfig[] };
  /** The chips above every chat's composer; Work's own list by default. */
  chips?: ChipsConfig;
}

/**
 * Where a chat's chips come from (ADR 0239): Work's `work:chips`, or a
 * module in the project that reads it (its access lists `chips`, ADR 0277)
 * and sorts, groups, filters or adds to it. The rail draws whatever the
 * source returns.
 */
export interface ChipsConfig {
  /** `work:chips`, or a module path relative to the project. */
  source: string;
}

/**
 * A palette mode (ADR 0186): a typed trigger that scopes palette search to
 * one list of rows. Rows come from the same sources sidebar sections use,
 * so a list can be a section, a mode, or both.
 */
export interface PaletteModeConfig {
  id: string;
  /** Typed name that enters the mode, with or without a leading @. */
  trigger: string;
  aliases?: string[];
  /** Chip text and the name in the @ list. */
  title: string;
  /** One line in the @ list saying what the mode finds. */
  description?: string;
  /** Lucide icon name for the chip and rows without their own icon. */
  icon?: string;
  placeholder?: string;
  /** `work:<name>`, or a module path: the same sources sections name. */
  source?: string;
  /** Reuse a section's rows (its source or items) by section id. */
  section?: string;
  /** Static rows; nested items are listed flat. */
  items?: SidebarItem[];
  /**
   * "palette" (default) loads rows once and ranks them as the user types.
   * "source" passes the typed query to the module's load, for APIs that
   * search server-side.
   */
  search?: "palette" | "source";
  /** Also rank this mode's rows in the unscoped palette (palette search only). */
  topLevel?: boolean;
  when?: SidebarWhen;
}
