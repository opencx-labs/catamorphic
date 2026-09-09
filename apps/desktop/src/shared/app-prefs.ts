import {
  normalizeTerminalMacros,
  type TerminalMacro,
} from "./terminal-macros.js";

/**
 * Per-profile app preferences, stored as plain JSON at
 * `profiles/<id>/prefs.json` — same philosophy as keybindings.json: user-
 * and agent-editable, file-watched, applies live. Grows one flat key per
 * preference; unknown keys are preserved on save so future versions (or
 * outside tools) can add keys without this build eating them.
 */
export interface AppPrefs {
  /** Soft chime when an agent finishes or asks a question. */
  notificationSounds: boolean;
  /** OS notification for the same events while the app is unfocused. */
  desktopNotifications: boolean;
  /** Whether the left sidebar is shown. */
  sidebarOpen: boolean;
  /** Workspace tabs can live above the content or in the sidebar. */
  tabPlacement: "top" | "sidebar";
  headerPlacement: "top" | "sidebar";
  /** Optional rounded, inset frame around workspace tab content. */
  tabFrame: boolean;
  /** Profile-wide favorites can be compact tiles or labeled rows. */
  pinnedBookmarks: "tiles" | "list";
  linkOpenMode: "tab" | "floating";
  previewLinksWithAlt: boolean;
  terminalMacros: TerminalMacro[];
  terminalAppearance: "app" | "ghostty";
  rightSidebarOpen: boolean;
  /** The project the profile last worked in — where a relaunch lands. */
  lastProjectId?: string;
  /** Sessions this profile has explicitly or implicitly marked unread. */
  unreadSessionIds: string[];
}

export const DEFAULT_PREFS: AppPrefs = {
  notificationSounds: true,
  desktopNotifications: true,
  sidebarOpen: true,
  tabPlacement: "top",
  headerPlacement: "top",
  tabFrame: false,
  pinnedBookmarks: "tiles",
  linkOpenMode: "tab",
  previewLinksWithAlt: true,
  terminalMacros: [],
  terminalAppearance: "app",
  rightSidebarOpen: true,
  unreadSessionIds: [],
};

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.filter((item): item is string => typeof item === "string"),
    ),
  ];
}

export function normalizePrefs(raw: unknown): AppPrefs {
  const record =
    typeof raw === "object" && raw !== null
      ? (raw as Record<string, unknown>)
      : {};
  return {
    notificationSounds:
      typeof record.notificationSounds === "boolean"
        ? record.notificationSounds
        : DEFAULT_PREFS.notificationSounds,
    desktopNotifications:
      typeof record.desktopNotifications === "boolean"
        ? record.desktopNotifications
        : DEFAULT_PREFS.desktopNotifications,
    rightSidebarOpen:
      typeof record.rightSidebarOpen === "boolean"
        ? record.rightSidebarOpen
        : DEFAULT_PREFS.rightSidebarOpen,
    sidebarOpen:
      typeof record.sidebarOpen === "boolean"
        ? record.sidebarOpen
        : DEFAULT_PREFS.sidebarOpen,
    tabPlacement: record.tabPlacement === "sidebar" ? "sidebar" : "top",
    headerPlacement: record.headerPlacement === "sidebar" ? "sidebar" : "top",
    tabFrame:
      typeof record.tabFrame === "boolean"
        ? record.tabFrame
        : DEFAULT_PREFS.tabFrame,
    pinnedBookmarks: record.pinnedBookmarks === "list" ? "list" : "tiles",
    terminalAppearance:
      record.terminalAppearance === "ghostty" ? "ghostty" : "app",
    linkOpenMode: record.linkOpenMode === "floating" ? "floating" : "tab",
    previewLinksWithAlt:
      typeof record.previewLinksWithAlt === "boolean"
        ? record.previewLinksWithAlt
        : true,
    terminalMacros: normalizeTerminalMacros(record.terminalMacros),
    ...(typeof record.lastProjectId === "string"
      ? { lastProjectId: record.lastProjectId }
      : {}),
    unreadSessionIds: stringList(record.unreadSessionIds),
  };
}
