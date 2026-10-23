import { type LucideIcon, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { OpenMode as CommitMode } from "../../../shared/open-mode.js";
import { webUsageKey } from "../../../shared/palette.js";
import {
  type SidebarItem,
  type SidebarSectionConfig,
  sectionModule,
  workSourceName,
} from "../../../shared/sidebar.js";
import type { SidebarSourceItem } from "../../../shared/sidebar-source.js";
import {
  sidebarSections,
  type WorkspaceConfig,
} from "../../../shared/workspace-config.js";
import { sidebarItemPresentation } from "../../components/sidebar-contribution.js";
import { lucideIcon } from "../../lib/lucide-icon.js";
import type { SectionSource } from "../../sources/contract.js";
import { itemsSource } from "../../sources/items.js";
import { moduleSource } from "../../sources/module.js";
import type { WorkSources } from "../../sources/registry.js";
import { runRowAction } from "../../sources/run.js";
import { loadSourceRows } from "../sources.js";
import type { PaletteItem, PaletteMode } from "../types.js";

/** What owns a list of rows: a palette mode or a sidebar section. */
export interface RowOwner {
  id: string;
  title: string;
}

const ROW_LIMIT = 1000;
const PAGE_LIMIT = 50;

/**
 * Every row a source offers, roots first, then children, up to the limits.
 * A source that searches (search "source") returns its best matches in one
 * page: only that page is read, per keystroke.
 */
async function sourceRows({
  source,
  query,
  signal,
}: {
  source: SectionSource;
  query?: string;
  signal: AbortSignal;
}): Promise<Array<{ item: SidebarSourceItem; parent?: string }>> {
  const rows: Array<{ item: SidebarSourceItem; parent?: string }> = [];
  // A page may start a few rows early (chats do, so none is skipped): each
  // row is listed once.
  const listed = new Set<string>();
  const queue: Array<{ parentId: string | null; parent?: string }> = [
    { parentId: null },
  ];
  let pages = 0;
  while (queue.length && rows.length < ROW_LIMIT) {
    const next = queue.shift();
    if (!next) break;
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      if (++pages > PAGE_LIMIT) return rows;
      signal.throwIfAborted();
      const page = await source.load({
        parentId: next.parentId,
        cursor,
        signal,
        size: 100,
        ...(query !== undefined ? { query } : {}),
      });
      for (const item of page.items) {
        if (item.hide || listed.has(item.id)) continue;
        listed.add(item.id);
        rows.push({ item, parent: next.parent });
        // A source that searches returns matches, not a tree to walk.
        if (item.hasChildren && query === undefined)
          queue.push({ parentId: item.id, parent: item.label });
      }
      // Stop on a repeated cursor or an empty page: a source that keeps
      // answering "more" without rows must not page forever.
      cursor =
        query === undefined &&
        page.items.length > 0 &&
        page.cursor &&
        !seen.has(page.cursor)
          ? page.cursor
          : undefined;
      if (cursor) seen.add(cursor);
    } while (cursor && rows.length < ROW_LIMIT);
  }
  return rows.slice(0, ROW_LIMIT);
}

/**
 * A source's rows as palette rows: Enter opens a row's address, or runs its
 * source's open action when it has none, the way a click on the row does.
 */
async function paletteRows({
  owner,
  source,
  icon,
  query,
  signal,
  open,
  onError,
  keep = () => true,
}: {
  owner: RowOwner;
  source: SectionSource;
  icon: LucideIcon;
  query?: string;
  signal: AbortSignal;
  open: (url: string, mode: CommitMode) => void;
  onError: (message: string) => void;
  keep?: (item: SidebarSourceItem) => boolean;
}): Promise<PaletteItem[]> {
  return (await sourceRows({ source, query, signal }))
    .filter(({ item }) => keep(item) && (item.url || !item.hasChildren))
    .map(({ item, parent }): PaletteItem => {
      const url = item.url;
      return {
        id: `mode:${owner.id}:${item.id}`,
        icon: lucideIcon(item.icon) ?? icon,
        label: item.label,
        url,
        detail: item.description ?? parent,
        keywords: [
          ...(item.keywords ?? []),
          ...(item.badges ?? []).map((badge) =>
            typeof badge === "string" ? badge : badge.label,
          ),
        ],
        category: "resource",
        usage: url ? webUsageKey(url) : `mode:${owner.id}:${item.id}`,
        disabled: !url && !source.action,
        kind: url ? "navigate" : "action",
        run: (commit) =>
          void runRowAction({
            source,
            row: item,
            itemId: item.id,
            action: "open",
            mode: commit,
            signal: new AbortController().signal,
            open,
          }).catch((cause: unknown) =>
            onError(
              cause instanceof Error && cause.message
                ? cause.message
                : `${owner.title}: the action failed.`,
            ),
          ),
      };
    });
}

/**
 * The rows behind a sidebar section, for its palette search: the same
 * source the section draws, without what the section hides.
 */
export async function sectionRows({
  section,
  source,
  signal,
  open,
  onError,
}: {
  section: SidebarSectionConfig;
  source: SectionSource;
  signal: AbortSignal;
  open: (url: string, mode: CommitMode) => void;
  onError: (message: string) => void;
}): Promise<PaletteItem[]> {
  return paletteRows({
    owner: { id: section.id, title: section.title || source.title },
    source,
    icon: Search,
    signal,
    open,
    onError,
    keep: (item) => !sidebarItemPresentation({ section, id: item.id }).hide,
  });
}

/**
 * workspace.js palette modes as palette modes (ADR 0186, 0234): rows from a
 * source (one of Work's lists, or a module in its Bun process), a section,
 * or static items. Member shells, where local code never runs, list no
 * module modes.
 */
export function customPaletteModes({
  config,
  projectId,
  memberShell,
  onOpenUrl,
  onError,
  sources,
}: {
  config: WorkspaceConfig | null;
  projectId: string | undefined;
  memberShell: boolean;
  onOpenUrl: (url: string, commit: CommitMode) => void;
  /** A row's action failed after the palette closed. */
  onError: (message: string) => void;
  sources: WorkSources;
}): Array<PaletteMode & { topLevel: boolean }> {
  const sections = sidebarSections(config);
  return (config?.palette?.modes ?? []).flatMap(
    (mode): Array<PaletteMode & { topLevel: boolean }> => {
      const section = mode.section
        ? sections.find((item) => item.id === mode.section)
        : undefined;
      // A mode over a section hidden here (when.permissions) hides with it.
      if (mode.section && !section) return [];
      const icon = lucideIcon(mode.icon) ?? Search;
      const base = {
        id: `custom:${mode.id}`,
        chip: mode.title,
        icon,
        placeholder: mode.placeholder ?? `Search ${mode.title.toLowerCase()}…`,
        names: [mode.trigger, ...(mode.aliases ?? [])],
        label: mode.title,
        description: mode.description ?? `Search ${mode.title.toLowerCase()}`,
        topLevel: mode.topLevel === true,
      };
      const owner = { id: mode.id, title: mode.title };
      const named = mode.source ?? section?.source;
      const listed = workSourceName(named);
      if (listed) {
        if (!projectId) return [];
        return [
          {
            ...base,
            rows: {
              kind: "load",
              key: `${projectId}:${mode.id}:${listed}`,
              filtered: false,
              load: async (_query, signal) => ({
                items: await loadSourceRows({
                  sources,
                  source: listed,
                  projectId,
                  signal,
                  onError,
                  ...(section
                    ? {
                        keep: (item) =>
                          !sidebarItemPresentation({ section, id: item.id })
                            .hide,
                      }
                    : {}),
                }),
              }),
            },
          },
        ];
      }
      const module = mode.source ?? sectionModule(section);
      if (!module) {
        const items: readonly SidebarItem[] =
          mode.items ?? section?.items ?? [];
        return [
          {
            ...base,
            rows: {
              kind: "load",
              key: `${mode.id}:items:${JSON.stringify(items)}`,
              filtered: false,
              load: async (_query, signal) => ({
                items: await paletteRows({
                  owner,
                  source: itemsSource({ items, ownerId: mode.id }),
                  icon,
                  signal,
                  open: onOpenUrl,
                  onError,
                }),
              }),
            },
          },
        ];
      }
      if (memberShell || !projectId) return [];
      const filtered = mode.search === "source";
      // A mode over a section runs the section's module, by its id.
      const source = moduleSource({
        projectId,
        ownerId: mode.source ? mode.id : (section?.id ?? mode.id),
        title: mode.title,
        work: sources,
      });
      return [
        {
          ...base,
          rows: {
            kind: "load",
            key: `${projectId}:${mode.id}:${module}`,
            filtered,
            debounceMs: 200,
            load: async (query, signal) => ({
              items: await paletteRows({
                owner,
                source,
                icon,
                ...(filtered ? { query } : {}),
                signal,
                open: onOpenUrl,
                onError,
              }),
            }),
          },
        },
      ];
    },
  );
}

/**
 * Rows of every topLevel custom mode, loaded while the unscoped palette is
 * open so they rank beside everything else.
 */
export function useTopLevelModeRows(
  modes: ReadonlyArray<PaletteMode & { topLevel: boolean }>,
  active: boolean,
): PaletteItem[] {
  const topLevel = useMemo(
    () => modes.filter((mode) => mode.topLevel),
    [modes],
  );
  const key = topLevel
    .map((mode) => (mode.rows.kind === "load" ? mode.rows.key : mode.id))
    .join("\n");
  const [loaded, setLoaded] = useState<{
    key: string;
    items: PaletteItem[];
  }>({ key: "", items: [] });
  // biome-ignore lint/correctness/useExhaustiveDependencies: key names every loaded source; closures change every render
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    void Promise.all(
      topLevel.map((mode) =>
        mode.rows.kind === "load"
          ? mode.rows
              .load("", controller.signal)
              .then((result) => result.items)
              .catch(() => [])
          : Promise.resolve([]),
      ),
    ).then((lists) => {
      if (!controller.signal.aborted) setLoaded({ key, items: lists.flat() });
    });
    return () => controller.abort();
  }, [active, key]);
  return useMemo(
    () => [
      ...topLevel.flatMap((mode) =>
        mode.rows.kind === "list" ? mode.rows.items : [],
      ),
      ...(loaded.key === key ? loaded.items : []),
    ],
    [topLevel, loaded, key],
  );
}
