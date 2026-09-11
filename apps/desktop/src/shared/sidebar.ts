import type { OpenMode } from "./open-mode.js";
import {
  matchesProjectExperience,
  type ProjectExperienceWhen,
} from "./project-experience.js";

/** What a click (or menu entry) does. Declarative so it can cross IPC. */
export type SidebarAction =
  | "open" // open the item's url per its `open` mode
  | "open-tab" // force a new browser tab
  | "open-side"
  | "open-floating"
  | "open-here" // force reuse of the focused browser tab
  | "copy-url"
  | "pin" // bookmarks: promote to the profile-wide list
  | "unpin"
  | "edit"
  | "rename"
  | "close"
  | "remove"
  | "archive"
  | "unarchive"
  | "mark-read"
  | "mark-unread"
  | "stop"
  | "new-subsession"
  | "history"
  | "publish"
  | "fork"
  | "new-chat"
  | "new-workflow"
  | "refresh"
  | "search";

export interface SidebarMenuEntry {
  label: string;
  action: SidebarAction;
  /** Render in the danger color (destructive). */
  danger?: boolean;
  icon?: string;
  /** A resource destination can be supplied independently of the row. */
  url?: string;
  disabledReason?: string;
}

export interface SidebarSurface {
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
  session?: boolean;
  pathPrefix?: string;
  selection?: boolean;
}

export interface SidebarSource {
  type: SidebarSectionConfig["type"];
  scope?: "project" | "session" | "children";
  filter?: Record<string, string | number | boolean>;
  sort?: { field: string; direction?: "asc" | "desc" };
  groupBy?: string;
  pageSize?: number;
  includeLatent?: boolean;
}

export interface SidebarItemPresentation {
  label?: string;
  description?: string;
  icon?: string;
  badges?: string[];
  progress?: number;
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
  /** Optional for a folder-only item. */
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

export interface SidebarSectionConfig {
  id: string;
  /** Explicit sources made available to this sandboxed app widget. */
  collections?: string[];
  /** Reuse any built-in source, independently of the section's preset. */
  source?: SidebarSource;
  itemDefaults?: SidebarItemPresentation;
  itemOverrides?: Record<string, SidebarItemPresentation>;
  headerActions?: SidebarMenuEntry[];
  rowHeight?: number;
  contextMenu?: SidebarMenuEntry[];
  actions?: SidebarMenuEntry[];
  /** App name for app widgets; project-relative document path for notes. */
  app?: string;
  path?: string;
  height?: number;
  type:
    | "workflows"
    | "apps"
    | "files"
    | "chats"
    | "subsessions"
    | "tabs"
    | "bookmarks"
    | "git"
    | "prs"
    | "remote"
    | "custom"
    | "activity"
    | "note"
    | "app";
  /** Override the section heading. */
  title?: string;
  /** Start collapsed (default open). */
  collapsed?: boolean;
  /**
   * Hide the whole section (header included) while it has nothing to
   * list. Defaults to true for workflows, apps, remote, and git sections.
   */
  hideEmpty?: boolean;
  /** For type "custom": the entries to render. */
  items?: SidebarItem[];
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
export interface SidebarConfig {
  left: SidebarTabConfig[];
  right: SidebarTabConfig[];
}

export function sidebarSections(config: SidebarConfig | null | undefined) {
  return [...(config?.left ?? []), ...(config?.right ?? [])].flatMap(
    (tab) => tab.sections,
  );
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
      when.selection === Boolean(surface.selection))
  );
}

/** Presets are defaults over the same sources, never separate custom renderers. */
export function resolveSidebarSection(
  section: SidebarSectionConfig,
): SidebarSectionConfig {
  return { ...section, type: section.source?.type ?? section.type };
}

/** Resolve the same authorized presentation for sidebars, search and agent discovery. */
export function visibleSidebarConfig({
  config,
  context,
}: {
  config: SidebarConfig | null;
  context: import("./project-experience.js").ProjectExperienceContext;
}): SidebarConfig | null {
  if (!config) return null;
  const items = (
    entries: SidebarItem[] | undefined,
  ): SidebarItem[] | undefined =>
    entries?.flatMap((entry) => {
      if (!matchesProjectExperience(entry.when, context)) return [];
      const children = items(entry.items);
      return entry.url || entry.actions?.length || children?.length
        ? [{ ...entry, items: children }]
        : [];
    });
  const tabs = (entries: SidebarTabConfig[]): SidebarTabConfig[] =>
    entries
      .filter((tab) => matchesProjectExperience(tab.when, context))
      .map((tab) => ({
        ...tab,
        sections: tab.sections
          .filter(
            (section) =>
              matchesProjectExperience(section.when, context) &&
              (context.builder ||
                !["git", "prs"].includes(section.source?.type ?? section.type)),
          )
          .map((section) => ({ ...section, items: items(section.items) })),
      }))
      .filter((tab) => tab.sections.length > 0);
  return { left: tabs(config.left), right: tabs(config.right) };
}
