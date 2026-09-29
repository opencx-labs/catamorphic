import {
  matchesProjectExperience,
  type ProjectExperienceContext,
} from "./project-experience.js";
import type {
  SidebarItem,
  SidebarSectionConfig,
  SidebarSource,
  SidebarTabConfig,
  SidebarWhen,
} from "./sidebar.js";

/** Every built-in list the workspace offers, by source name. */
export const WORKSPACE_SOURCES = [
  "chats",
  "subsessions",
  "activity",
  "files",
  "workflows",
  "apps",
  "git",
  "prs",
  "bookmarks",
  "remote",
  "tabs",
] as const;
export type WorkspaceSourceName = (typeof WORKSPACE_SOURCES)[number];
export const isWorkspaceSource = (name: string): name is WorkspaceSourceName =>
  WORKSPACE_SOURCES.some((source) => source === name);

/**
 * The workspace file (`workspace.js`, ADR 0186): what the window offers for
 * this profile or project. Its sidebars and its palette modes are read from
 * one file, layered personal, then project, then profile, then built in.
 */
export interface WorkspaceConfig {
  sidebars: { left: SidebarTabConfig[]; right: SidebarTabConfig[] };
  palette?: { modes: PaletteModeConfig[] };
}

/**
 * A palette mode (ADR 0186): a typed trigger that scopes palette search to
 * one list of rows. Rows come from the same primitives sidebar sections use,
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
  /** An executable source module, the same contract as a section's. */
  source?: SidebarSource;
  /** Reuse a custom section's rows (its module or items) by section id. */
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

export function sidebarSections(
  config: WorkspaceConfig | null | undefined,
): SidebarSectionConfig[] {
  return [
    ...(config?.sidebars.left ?? []),
    ...(config?.sidebars.right ?? []),
  ].flatMap((tab) => tab.sections);
}

/** The executable module behind a section or palette mode id, if any. */
export function executableSourceModule(
  config: WorkspaceConfig | null | undefined,
  id: string,
): string | undefined {
  const sections = sidebarSections(config);
  const section = sections.find((item) => item.id === id);
  if (section) return section.source?.module;
  const mode = config?.palette?.modes.find((item) => item.id === id);
  if (!mode) return undefined;
  return (
    mode.source?.module ??
    sections.find((item) => item.id === mode.section)?.source?.module
  );
}

/** Resolve the same authorized presentation for sidebars, search and agent discovery. */
export function visibleWorkspaceConfig({
  config,
  context,
}: {
  config: WorkspaceConfig | null;
  context: ProjectExperienceContext;
}): WorkspaceConfig | null {
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
              (context.root ||
                context.permissions.includes("program:write") ||
                !["git"].includes(section.source?.type ?? section.type)),
          )
          .map((section) => ({ ...section, items: items(section.items) })),
      }))
      .filter((tab) => tab.sections.length > 0);
  const modes = config.palette?.modes
    .filter((mode) => matchesProjectExperience(mode.when, context))
    .map((mode) => ({ ...mode, items: items(mode.items) }));
  return {
    sidebars: {
      left: tabs(config.sidebars.left),
      right: tabs(config.sidebars.right),
    },
    ...(modes?.length ? { palette: { modes } } : {}),
  };
}
