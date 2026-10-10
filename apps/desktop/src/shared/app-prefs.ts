import {
  normalizeTerminalMacros,
  type TerminalMacro,
} from "./terminal-macros.js";
import {
  DEFAULT_VOICE,
  type VoiceId,
  type VoiceSessionRef,
  voiceIdOf,
} from "./voice.js";

export const CODE_THEMES = [
  "github",
  "catppuccin",
  "rose-pine",
  "one",
  "solarized",
  "vitesse",
] as const;
export type CodeTheme = (typeof CODE_THEMES)[number];

/** How long a browser tab is out of sight before it sleeps (ADR 0194). */
export const BROWSER_TAB_SLEEP = ["15m", "30m", "1h", "2h", "never"] as const;
export type BrowserTabSleep = (typeof BROWSER_TAB_SLEEP)[number];
export const BROWSER_TAB_SLEEP_MINUTES: Record<BrowserTabSleep, number | null> =
  { "15m": 15, "30m": 30, "1h": 60, "2h": 120, never: null };

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
  /** Where the collapsed bubble rests: a bottom corner. */
  dockSide: "left" | "right";
  /** Where open chats and their bubble strip sit while expanded. */
  dockPlacement: "left" | "center" | "right";
  /**
   * The person folded the bubble strip into one bubble (its arrows), and
   * it stays folded, in every window and across launches, until they open
   * it again. Runtime state, not a setting.
   */
  dockCollapsed: boolean;
  /**
   * An agent turn is work (notes between tool calls, plus the tool steps)
   * followed by an answer. Two choices cover how the work reads: while the
   * turn runs, and once the answer has landed. "notes" (Notes only) keeps
   * steps folded in both phases.
   */
  chatWorkLive: "all" | "latest" | "notes";
  chatWorkSettled: "keep" | "collapse";
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
  /**
   * Framed content insets the workspace as a rounded, bordered window;
   * padding and radius are that frame's dimensions and only apply when
   * it is on. Off by default: content sits flush with the sidebars.
   */
  contentFrame: boolean;
  sidebarDividers: boolean;
  contentPadding: number;
  contentRadius: number;
  /** Profile-wide favorites can be compact tiles or labeled rows. */
  pinnedBookmarks: "tiles" | "list";
  linkOpenMode: "tab" | "floating";
  previewLinksWithAlt: boolean;
  /** How long a browser tab stays out of sight before it sleeps. */
  browserTabSleep: BrowserTabSleep;
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
  /**
   * Apps this profile allowed to read its chats, as `<projectId>/<app>`
   * (ADR 0148). Asked once per app; a rebuilt version that drops the
   * declaration needs no new answer because it gains no access.
   */
  appAccessApprovals: string[];
  /**
   * The assistant's chat (ADR 0216): where the dock's microphone sends what
   * it hears, until a reset (or another assistant) closes it and the next
   * start makes another.
   */
  assistantSession: VoiceSessionRef | null;
  /** The last assistant reply spoken to the person (ADR 0216). */
  assistantHeardThrough: string | null;
  /**
   * The agent the assistant is: one of the person's own; null is Work's
   * built-in assistant, on their default agent.
   */
  voiceAssistant: string | null;
  /** The voice agents speak in, unless they have their own. */
  voiceId: VoiceId;
  /** Agents' own voices, by agent id. */
  agentVoices: Record<string, VoiceId>;
  /** The microphone voice listens with; null follows the system's. */
  voiceMicrophone: string | null;
  /** The person's voice print: voice ignores everyone else (ADR 0216). */
  voiceprint: number[] | null;
  /** The microphone in the dock; voice still works by its shortcut. */
  voiceInDock: boolean;
  /** A microphone in every chat's composer, to talk to that chat's agent. */
  voiceInChats: boolean;
  /** Voice listens only while the push-to-talk keys are held. */
  voicePushToTalk: boolean;
}

export const DEFAULT_PREFS: AppPrefs = {
  dockMultiProject: false,
  dockDetached: false,
  dockSide: "right",
  dockPlacement: "center",
  dockCollapsed: false,
  chatWorkLive: "all",
  chatWorkSettled: "collapse",
  notificationSounds: true,
  desktopNotifications: true,
  sidebarOpen: true,
  tabPlacement: "top",
  tabAlignment: "start",
  headerPlacement: "top",
  contentFrame: false,
  sidebarDividers: false,
  contentPadding: 6,
  contentRadius: 14,
  pinnedBookmarks: "tiles",
  linkOpenMode: "tab",
  previewLinksWithAlt: true,
  browserTabSleep: "1h",
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
  rightSidebarOpen: false,
  unreadSessionIds: [],
  appAccessApprovals: [],
  assistantSession: null,
  assistantHeardThrough: null,
  voiceAssistant: null,
  agentVoices: {},
  voiceId: DEFAULT_VOICE,
  voiceMicrophone: null,
  voiceprint: null,
  voiceInDock: true,
  voiceInChats: true,
  voicePushToTalk: false,
};

function dimension(value: unknown, fallback: number, max: number): number {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= max
    ? value
    : fallback;
}

function agentVoicesOf(value: unknown): Record<string, VoiceId> {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([agentId, voice]) =>
      typeof voice === "string" && voiceIdOf(voice) === voice
        ? [[agentId, voice]]
        : [],
    ),
  );
}

function voiceSessionRef(value: unknown): VoiceSessionRef | null {
  if (typeof value !== "object" || value === null) return null;
  const projectId: unknown = Reflect.get(value, "projectId");
  const sessionId: unknown = Reflect.get(value, "sessionId");
  return typeof projectId === "string" && typeof sessionId === "string"
    ? { projectId, sessionId }
    : null;
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
    dockCollapsed: record.dockCollapsed === true,
    chatWorkLive:
      record.chatWorkLive === "latest" || record.chatWorkLive === "notes"
        ? record.chatWorkLive
        : "all",
    chatWorkSettled: record.chatWorkSettled === "keep" ? "keep" : "collapse",
    dockPlacement:
      record.dockPlacement === "left" || record.dockPlacement === "right"
        ? record.dockPlacement
        : "center",
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
    contentFrame: record.contentFrame === true,
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
    browserTabSleep:
      BROWSER_TAB_SLEEP.find((value) => value === record.browserTabSleep) ??
      DEFAULT_PREFS.browserTabSleep,
    terminalMacros: normalizeTerminalMacros(record.terminalMacros),
    ...(typeof record.lastProjectId === "string"
      ? { lastProjectId: record.lastProjectId }
      : {}),
    unreadSessionIds: stringList(record.unreadSessionIds),
    appAccessApprovals: stringList(record.appAccessApprovals),
    assistantSession: voiceSessionRef(record.assistantSession),
    assistantHeardThrough:
      typeof record.assistantHeardThrough === "string"
        ? record.assistantHeardThrough
        : null,
    voiceAssistant:
      typeof record.voiceAssistant === "string" && record.voiceAssistant
        ? record.voiceAssistant
        : null,
    voiceId: voiceIdOf(record.voiceId),
    agentVoices: agentVoicesOf(record.agentVoices),
    voiceprint:
      Array.isArray(record.voiceprint) &&
      record.voiceprint.length > 0 &&
      record.voiceprint.every((value) => typeof value === "number")
        ? record.voiceprint
        : null,
    voiceMicrophone:
      typeof record.voiceMicrophone === "string" && record.voiceMicrophone
        ? record.voiceMicrophone
        : null,
    voiceInDock: record.voiceInDock !== false,
    voiceInChats: record.voiceInChats !== false,
    voicePushToTalk: record.voicePushToTalk === true,
  };
}
