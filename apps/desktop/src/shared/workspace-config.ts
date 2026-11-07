import {
  matchesProjectExperience,
  type ProjectExperienceContext,
} from "./project-experience.js";
import {
  type SidebarItem,
  type SidebarSectionConfig,
  type SidebarTabConfig,
  sectionModule,
  workSourceName,
} from "./sidebar.js";

export type {
  ChipsConfig,
  PaletteModeConfig,
  WorkspaceConfig,
} from "@catamorphic/work-customization";

import type { WorkspaceConfig } from "@catamorphic/work-customization";

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
): { module: string } | undefined {
  // What a module reaches is declared beside it, never here (ADR 0277).
  if (id === CHIPS_OWNER_ID) {
    const module = chipsModule(config);
    return module ? { module } : undefined;
  }
  const sections = sidebarSections(config);
  const section = sections.find((item) => item.id === id);
  const mode = section
    ? undefined
    : config?.palette?.modes.find((item) => item.id === id);
  const shown = mode?.section
    ? sections.find((item) => item.id === mode.section)
    : undefined;
  const module = section
    ? sectionModule(section)
    : mode?.source && !mode.source.startsWith("work:")
      ? mode.source
      : sectionModule(shown);
  return module && (section ?? mode) ? { module } : undefined;
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
