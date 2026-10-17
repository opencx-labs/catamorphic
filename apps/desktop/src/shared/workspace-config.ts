import {
  matchesProjectExperience,
  type ProjectExperienceContext,
} from "./project-experience.js";
import {
  type SidebarItem,
  type SidebarSectionConfig,
  type SidebarTabConfig,
  type SidebarWhen,
  sectionModule,
  workSourceName,
} from "./sidebar.js";

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
 * module in the project that reads it (`collections: ["chips"]`) and sorts,
 * groups, filters or adds to it. The rail draws whatever the source returns.
 */
export interface ChipsConfig {
  /** `work:chips`, or a module path relative to the project. */
  source: string;
  collections?: string[];
  workflows?: string[];
}

/**
 * The owner id a chips module answers to: sections, palette modes and the
 * chips share one namespace of executable sources, so no section or mode
 * may take it. It is also the one list a chips module may read (its chat's
 * chips, `work.read({ source: "chips" })`): the chips run beside the chat,
 * in whichever window shows it, where Work's other lists are not.
 */
export const CHIPS_OWNER_ID = "chips";

/** Work's own chips: what the chat holds, before any module reshapes it. */
export const WORK_CHIPS_SOURCE = "work:chips";

/** The module behind a chat's chips, when they come from code in the project. */
export function chipsModule(
  config: WorkspaceConfig | null | undefined,
): string | undefined {
  const source = config?.chips?.source;
  return source && source !== WORK_CHIPS_SOURCE ? source : undefined;
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
  /** A module mode's grants, as a section's (ADR 0234). */
  collections?: string[];
  workflows?: string[];
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

/**
 * What a section or palette mode id runs as a module, with the grants that
 * bound what it may ask Work for (ADR 0234).
 */
export function executableSource(
  config: WorkspaceConfig | null | undefined,
  id: string,
): { module: string; collections: string[]; workflows: string[] } | undefined {
  if (id === CHIPS_OWNER_ID) {
    const module = chipsModule(config);
    return module
      ? {
          module,
          collections: config?.chips?.collections ?? [],
          workflows: config?.chips?.workflows ?? [],
        }
      : undefined;
  }
  const sections = sidebarSections(config);
  const section = sections.find((item) => item.id === id);
  const mode = section
    ? undefined
    : config?.palette?.modes.find((item) => item.id === id);
  const owner = section ?? mode;
  const shown = mode?.section
    ? sections.find((item) => item.id === mode.section)
    : undefined;
  const module = section
    ? sectionModule(section)
    : mode?.source && !mode.source.startsWith("work:")
      ? mode.source
      : sectionModule(shown);
  if (!module || !owner) return undefined;
  const grants = mode?.source ? mode : (shown ?? owner);
  return {
    module,
    collections: grants.collections ?? [],
    workflows: grants.workflows ?? [],
  };
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
  // The project's git checkouts are for people who edit its program.
  const programWriter =
    context.root || context.permissions.includes("program:write");
  const tabs = (entries: SidebarTabConfig[]): SidebarTabConfig[] =>
    entries
      .filter((tab) => matchesProjectExperience(tab.when, context))
      .map((tab) => ({
        ...tab,
        sections: tab.sections
          .filter(
            (section) =>
              matchesProjectExperience(section.when, context) &&
              (programWriter || workSourceName(section.source) !== "git"),
          )
          .map((section) =>
            section.items
              ? { ...section, items: items(section.items) }
              : section,
          ),
      }))
      .filter((tab) => tab.sections.length > 0);
  const modes = config.palette?.modes
    .filter((mode) => matchesProjectExperience(mode.when, context))
    .map((mode) => (mode.items ? { ...mode, items: items(mode.items) } : mode));
  return {
    sidebars: {
      left: tabs(config.sidebars.left),
      right: tabs(config.sidebars.right),
    },
    ...(modes?.length ? { palette: { modes } } : {}),
    ...(config.chips ? { chips: config.chips } : {}),
  };
}
