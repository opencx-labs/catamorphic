import {
  normalizeTerminalMacros,
  type TerminalMacro,
} from "./terminal-macros.js";

export const CODE_THEMES = [
  "github",
  "catppuccin",
  "rose-pine",
  "one",
  "solarized",
  "vitesse",
] as const;
export type CodeTheme = (typeof CODE_THEMES)[number];

/**
 * Per-profile app preferences, stored as plain JSON at
 * `profiles/<id>/prefs.json` — same philosophy as keybindings.json: user-
 * and agent-editable, file-watched, applies live. Grows one flat key per
 * preference; unknown keys are preserved on save so future versions (or
 * outside tools) can add keys without this build eating them.
 */
export interface AppPrefs {
  dockMultiProject: boolean;
  dockDetached: boolean;
  dockSide: "left" | "right";
  /** Soft chime when an agent finishes or asks a question. */
  notificationSounds: boolean;
  /** OS notification for the same events while the app is unfocused. */
  desktopNotifications: boolean;
  /** Whether the left sidebar is shown. */
  sidebarOpen: boolean;
  /** Workspace tabs can live above the content or in the sidebar. */
  tabPlacement: "top" | "sidebar";
  tabAlignment: "start" | "center";
  headerPlacement: "top" | "sidebar";
  /** Optional rounded, inset frame around workspace tab content. */
  tabFrame: boolean;
  sidebarDividers: boolean;
  contentPadding: number;
  contentRadius: number;
  /** Profile-wide favorites can be compact tiles or labeled rows. */
  pinnedBookmarks: "tiles" | "list";
  linkOpenMode: "tab" | "floating";
  previewLinksWithAlt: boolean;
  terminalMacros: TerminalMacro[];
  terminalAppearance: "app" | "ghostty";
  codeTheme: CodeTheme;
  diffLayout: "split" | "unified";
  diffWrap: boolean;
  githubCliEnabled: boolean;
  reviewStartView: "overview" | "guide" | "diff";
  reviewGrouping: "purpose" | "directory" | "flat";
  changesFileLayout: "tree" | "flat";
  prDefaultView: "for-you" | "created" | "all";
  rightSidebarOpen: boolean;
  /** The project the profile last worked in — where a relaunch lands. */
  lastProjectId?: string;
  /** Sessions this profile has explicitly or implicitly marked unread. */
  unreadSessionIds: string[];
}

export const DEFAULT_PREFS: AppPrefs = {
  dockMultiProject: false,
  dockDetached: false,
  dockSide: "right",
  notificationSounds: true,
  desktopNotifications: true,
  sidebarOpen: true,
  tabPlacement: "top",
  tabAlignment: "start",
  headerPlacement: "top",
  tabFrame: false,
  sidebarDividers: false,
  contentPadding: 6,
  contentRadius: 14,
  pinnedBookmarks: "tiles",
  linkOpenMode: "tab",
  previewLinksWithAlt: true,
  terminalMacros: [],
  terminalAppearance: "app",
  codeTheme: "github",
  diffLayout: "split",
  diffWrap: false,
  githubCliEnabled: false,
  reviewStartView: "overview",
  reviewGrouping: "purpose",
  changesFileLayout: "tree",
  prDefaultView: "for-you",
  rightSidebarOpen: true,
  unreadSessionIds: [],
};

function dimension(value: unknown, fallback: number, max: number): number {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= max
    ? value
    : fallback;
}

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
    dockMultiProject: record.dockMultiProject === true,
    dockDetached: record.dockDetached === true,
    dockSide: record.dockSide === "left" ? "left" : "right",
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
    tabAlignment: record.tabAlignment === "center" ? "center" : "start",
    headerPlacement: record.headerPlacement === "sidebar" ? "sidebar" : "top",
    tabFrame:
      typeof record.tabFrame === "boolean"
        ? record.tabFrame
        : DEFAULT_PREFS.tabFrame,
    sidebarDividers: record.sidebarDividers === true,
    contentPadding: dimension(record.contentPadding, 6, 48),
    contentRadius: dimension(record.contentRadius, 14, 48),
    pinnedBookmarks: record.pinnedBookmarks === "list" ? "list" : "tiles",
    codeTheme:
      CODE_THEMES.find((name) => name === record.codeTheme) ?? "github",
    diffLayout: record.diffLayout === "unified" ? "unified" : "split",
    diffWrap: record.diffWrap === true,
    githubCliEnabled: record.githubCliEnabled === true,
    reviewStartView:
      record.reviewStartView === "diff"
        ? "diff"
        : record.reviewStartView === "guide"
          ? "guide"
          : "overview",
    reviewGrouping:
      record.reviewGrouping === "directory" || record.reviewGrouping === "flat"
        ? record.reviewGrouping
        : "purpose",
    changesFileLayout: record.changesFileLayout === "flat" ? "flat" : "tree",
    prDefaultView:
      record.prDefaultView === "created" || record.prDefaultView === "all"
        ? record.prDefaultView
        : "for-you",
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
