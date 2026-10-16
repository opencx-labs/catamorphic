import type { OpenMode } from "./open-mode.js";
import type { ProjectExperienceWhen } from "./project-experience.js";

/**
 * What Work itself does with any row (ADR 0234): open it in a mode, copy
 * its address, read the section again or search it. Every other action
 * name belongs to the row's source, which receives it in `action`.
 */
export const HOST_ACTIONS = [
  "open",
  "open-here",
  "open-tab",
  "open-side",
  "open-floating",
  "copy-url",
  "refresh",
  "search",
] as const;
export type HostAction = (typeof HOST_ACTIONS)[number];
export const isHostAction = (action: string): action is HostAction =>
  HOST_ACTIONS.some((name) => name === action);

/** A source's own action: lowercase words joined by dashes (`mark-read`). */
export const SOURCE_ACTION_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/**
 * Work's commands a source's rows and action effects may open: ones that
 * only open something for the person to act in. A layout (header actions,
 * items) may name any command; what a module returns may not archive a
 * chat or turn on the microphone because someone clicked its row.
 */
export const ROW_COMMANDS: ReadonlySet<string> = new Set([
  "new-tab",
  "new-floating-chat",
  "new-workflow",
  "search-files",
  "search-changes",
  "remote-environment",
  "server-members",
  "server-secrets",
  "server-connections",
]);

/** False for a `command:` address a source may not open. */
export function rowTargetAllowed(url: string): boolean {
  return (
    !url.startsWith("command:") ||
    ROW_COMMANDS.has(url.slice("command:".length))
  );
}

/**
 * A host verb or a source's action name. Declarative so it crosses IPC:
 * the row names what it wants and its source (or Work) does it.
 */
export type SidebarAction = string;

/** One value an action asks the person for before it runs. */
export interface SidebarInputField {
  /** The key the action receives the value under (`values.name`). */
  name: string;
  label: string;
  value?: string;
  placeholder?: string;
}

/** Up to four text values an action asks for first (a name, an address). */
export interface SidebarActionInput {
  title?: string;
  /** The confirming button's label (default "Save"). */
  submit?: string;
  fields: SidebarInputField[];
}

export interface SidebarMenuEntry {
  label: string;
  action: SidebarAction;
  /** Render in the danger color (destructive). */
  danger?: boolean;
  icon?: string;
  /**
   * A workspace target to open instead of running the action: a page, a
   * chat, `workflow:`, `app:`, `file:`, or `command:<id>` for one of
   * Work's commands.
   */
  url?: string;
  disabledReason?: string;
  /** Ask the person for values first; the action receives them. */
  input?: SidebarActionInput;
}

/** What an action asks Work to do once it has run. */
export interface SidebarSourceEffect {
  /** A workspace target to open, as a row's `url` opens. */
  open?: string;
  mode?: OpenMode;
  /** One short sentence saying what happened ("3 files uploaded"). */
  message?: string;
}

export interface SidebarSurface {
  /** Where the person placed the window's tabs (Settings). */
  tabPlacement?: "top" | "sidebar";
  kind: string;
  key?: string;
  projectId?: string;
  sessionId?: string;
  path?: string;
  selection?: boolean;
}

export interface SidebarWhen extends ProjectExperienceWhen {
  /** Relevance is evaluated even for root users. */
  surface?: string[];
  /**
   * Shown beside a chat (or what a chat opened) only. Its source receives
   * that chat, and a tab of such sections comes and goes with it.
   */
  session?: boolean;
  pathPrefix?: string;
  selection?: boolean;
  /**
   * Shown only while the window's tabs are placed there ("sidebar") or in
   * the top bar ("top"): the default Tabs section lists them in the sidebar.
   */
  tabPlacement?: "top" | "sidebar";
}

/** A small chip after a row's label, with an optional icon. */
export interface SidebarBadge {
  label: string;
  icon?: string;
}

/**
 * What a row is doing, drawn the same everywhere: a chat working, one that
 * needs the person, one they have not read; a deploy in progress.
 */
export type SidebarSignal = "working" | "attention" | "unread";

export interface SidebarItemPresentation {
  label?: string;
  description?: string;
  /** Extra words the palette matches this row by (synonyms, ids). */
  keywords?: string[];
  icon?: string;
  badges?: (string | SidebarBadge)[];
  progress?: number;
  signal?: SidebarSignal;
  open?: OpenMode;
  menu?: SidebarMenuEntry[];
  /** Omit to inherit overflow; [] disables the right-click menu. */
  contextMenu?: SidebarMenuEntry[];
  actions?: SidebarMenuEntry[];
  preview?: SidebarPreview | false;
  hide?: boolean;
}

export interface SidebarPreviewMetadata {
  label: string;
  value: string;
}

/** Compact, declarative content for a sidebar item's hover preview. */
export interface SidebarPreview {
  title?: string;
  description?: string;
  metadata?: SidebarPreviewMetadata[];
}

export interface SidebarItem extends SidebarItemPresentation {
  id?: string;
  label: string;
  /** A workspace target or a web address; a click opens it. */
  url?: string;
  /** Icon name from lucide-react, e.g. "Globe", "FileText". */
  icon?: string;
  open?: OpenMode;
  /** Hover menu (three-dots). Omit for the section default. */
  menu?: SidebarMenuEntry[];
  /** Hover preview content, or false to explicitly disable it. */
  preview?: SidebarPreview | false;
  /** Nested items use the same complete item model, at any depth. */
  items?: SidebarItem[];
  /** Start this item's children collapsed (default open). */
  collapsed?: boolean;
  /** Project-authorized visibility; invalid predicates fail closed. */
  when?: SidebarWhen;
}

/**
 * Work's own lists (ADR 0234), named `work:<name>` in a section's `source`
 * and by the bare name in grants and `work.read`. Each is a module on the
 * same contract as a person's source.
 */
export const WORK_SOURCES = [
  "pinned",
  "bookmarks",
  "library",
  "workflows",
  "apps",
  "chats",
  "subsessions",
  "activity",
  "files",
  "tabs",
  "remote",
  "git",
  "prs",
  "session",
] as const;
export type WorkSourceName = (typeof WORK_SOURCES)[number];
export const isWorkSourceName = (name: string): name is WorkSourceName =>
  WORK_SOURCES.some((source) => source === name);
/**
 * Lists of the chat beside them: their sections must say
 * `when: { session: true }`, which alone decides when they show.
 */
export const SESSION_WORK_SOURCES: readonly WorkSourceName[] = [
  "subsessions",
  "session",
];

/** `work:chats` → `chats`; a module path → undefined. */
export function workSourceName(
  source: string | undefined,
): WorkSourceName | undefined {
  if (!source?.startsWith("work:")) return undefined;
  const name = source.slice("work:".length);
  return isWorkSourceName(name) ? name : undefined;
}

/**
 * One sidebar section (ADR 0234): rows from a `source` (one of Work's
 * lists, or a module in the project), static `items`, an `app`, or a
 * `note`. Everything else is how it looks and when it shows.
 */
export interface SidebarSectionConfig {
  id: string;
  /** `work:<name>`, or a module path relative to the project. */
  source?: string;
  /** Static rows: links and folders of links. */
  items?: SidebarItem[];
  /** A project app, drawn compact. */
  app?: string;
  /** A project document (its path), or true to let the person pick one. */
  note?: string | true;
  /** The heading; empty for none. Defaults to the source's own name. */
  title?: string;
  /** "tiles" draws root rows without children as a grid of icons. */
  presentation?: "rows" | "tiles";
  /** Work lists an app or module may read and act on (bare names). */
  collections?: string[];
  /** Project workflows a module may call (`work.call`). */
  workflows?: string[];
  itemDefaults?: SidebarItemPresentation;
  itemOverrides?: Record<string, SidebarItemPresentation>;
  headerActions?: SidebarMenuEntry[];
  rowHeight?: number;
  contextMenu?: SidebarMenuEntry[];
  actions?: SidebarMenuEntry[];
  height?: number;
  /**
   * Show a scroll thumb on the sidebar's edge while this section's list
   * scrolls. Off by default: a list shows where it continues by fading
   * that edge.
   */
  scrollbar?: boolean;
  /** Start collapsed (default open). */
  collapsed?: boolean;
  /** Hide the whole section (header included) while it has nothing to list. */
  hideEmpty?: boolean;
  /** One sentence shown when the section has nothing to list. */
  empty?: string;
  /** Default click behavior for this section's items. */
  open?: OpenMode;
  /** Override the per-item hover menu for the whole section. */
  menu?: SidebarMenuEntry[];
  /** Project-authorized visibility; invalid predicates fail closed. */
  when?: SidebarWhen;
}

export interface SidebarTabConfig {
  id: string;
  title: string;
  icon?: string;
  sections: SidebarSectionConfig[];
  when?: SidebarWhen;
}

export type SidebarSide = "left" | "right";

/** What a section shows: rows from a source, static rows, an app or a note. */
export function sectionKind(
  section: SidebarSectionConfig,
): "source" | "items" | "app" | "note" {
  if (section.app !== undefined) return "app";
  if (section.note !== undefined) return "note";
  if (section.source !== undefined) return "source";
  return "items";
}

/** The module path behind a section, when its source is code in the project. */
export function sectionModule(
  section: SidebarSectionConfig | undefined,
): string | undefined {
  return section?.source && !section.source.startsWith("work:")
    ? section.source
    : undefined;
}

/**
 * Shown only beside a chat, or what a chat opened (ADR 0226): its source
 * receives that chat, and a tab of such sections comes and goes with it.
 */
export function sessionSection(section: SidebarSectionConfig): boolean {
  return section.when?.session === true;
}

export function matchesSidebarSurface(
  when: SidebarWhen | undefined,
  surface: SidebarSurface,
): boolean {
  return (
    (!when?.surface || when.surface.includes(surface.kind)) &&
    (when?.session === undefined ||
      when.session === Boolean(surface.sessionId)) &&
    (!when?.pathPrefix || Boolean(surface.path?.startsWith(when.pathPrefix))) &&
    (when?.selection === undefined ||
      when.selection === Boolean(surface.selection)) &&
    (when?.tabPlacement === undefined ||
      when.tabPlacement === (surface.tabPlacement ?? "top"))
  );
}
