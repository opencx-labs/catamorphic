import { type LucideIcon, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { OpenMode as CommitMode } from "../../../shared/open-mode.js";
import { webUsageKey } from "../../../shared/palette.js";
import {
  resolveSidebarSection,
  type SidebarItem,
  type SidebarSectionConfig,
} from "../../../shared/sidebar.js";
import type { SidebarSourceItem } from "../../../shared/sidebar-source.js";
import {
  isWorkspaceSource,
  sidebarSections,
  type WorkspaceConfig,
} from "../../../shared/workspace-config.js";
import { sidebarItemPresentation } from "../../components/sidebar-contribution.js";
import { desktopApi } from "../../lib/desktop-api.js";
import { lucideIcon } from "../../lib/lucide-icon.js";
import type { WorkspaceSources } from "../../lib/workspace-sources.js";
import { loadSourceRows } from "../sources.js";
import type { PaletteItem, PaletteMode } from "../types.js";

/** What owns a list of rows: a palette mode or a sidebar section. */
export interface RowOwner {
  id: string;
  title: string;
}

/** A source row as a palette row: open its url, else run its first command. */
function sourceRow({
  owner,
  item,
  parent,
  icon,
  onOpenUrl,
  onRun,
}: {
  owner: RowOwner;
  item: SidebarItem & { id: string };
  parent?: string;
  icon: LucideIcon;
  onOpenUrl: (url: string, commit: CommitMode) => void;
  onRun?: (itemId: string, action: string) => void;
}): PaletteItem {
  const command = [...(item.actions ?? []), ...(item.menu ?? [])].find(
    (entry) => entry.action.startsWith("run:") && !entry.disabledReason,
  );
  const url = item.url;
  return {
    id: `mode:${owner.id}:${item.id}`,
    icon: lucideIcon(item.icon) ?? icon,
    label: item.label,
    detail: item.description ?? parent,
    keywords: [...(item.keywords ?? []), ...(item.badges ?? [])],
    category: "resource",
    usage: url ? webUsageKey(url) : `mode:${owner.id}:${item.id}`,
    disabled: !url && !(command && onRun),
    kind: url ? "navigate" : "action",
    run: (commit) => {
      if (url) onOpenUrl(url, commit);
      else if (command && onRun)
        onRun(item.id, command.action.slice("run:".length));
    },
  };
}

/** Static rows open urls; folders contribute their children, flat. */
function flatten(
  items: readonly SidebarItem[] | undefined,
  parent?: string,
): Array<{ item: SidebarItem & { id: string }; parent?: string }> {
  return (items ?? []).flatMap((item) => [
    ...(item.url
      ? [{ item: { ...item, id: item.id ?? item.label }, parent }]
      : []),
    ...flatten(item.items, item.label),
  ]);
}

const MODULE_ROW_LIMIT = 1000;
const MODULE_PAGE_LIMIT = 50;

/**
 * Every row a module offers, roots first, then children, up to the limits.
 * A searching source returns its best matches in one page: only that page
 * is read, per keystroke.
 */
async function loadModuleRows({
  projectId,
  sourceId,
  query,
  signal,
}: {
  projectId: string;
  sourceId: string;
  query?: string;
  signal: AbortSignal;
}): Promise<Array<{ item: SidebarSourceItem; parent?: string }>> {
  const rows: Array<{ item: SidebarSourceItem; parent?: string }> = [];
  const queue: Array<{ parentId: string | null; parent?: string }> = [
    { parentId: null },
  ];
  let pages = 0;
  while (queue.length && rows.length < MODULE_ROW_LIMIT) {
    const next = queue.shift();
    if (!next) break;
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      if (++pages > MODULE_PAGE_LIMIT) return rows;
      signal.throwIfAborted();
      const requestId = crypto.randomUUID();
      const cancel = () => void desktopApi.sidebarSourceCancel(requestId);
      signal.addEventListener("abort", cancel, { once: true });
      try {
        const page = await desktopApi.sidebarSourceRequest({
          projectId,
          sectionId: sourceId,
          requestId,
          method: "load",
          parentId: next.parentId,
          cursor,
          ...(query !== undefined ? { query } : {}),
        });
        if (!page) throw new Error("Source returned no collection page.");
        for (const item of page.items) {
          if (item.hide) continue;
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
      } finally {
        signal.removeEventListener("abort", cancel);
      }
    } while (cursor && rows.length < MODULE_ROW_LIMIT);
  }
  return rows.slice(0, MODULE_ROW_LIMIT);
}

/** Static rows (custom section or mode items) as palette rows. */
export function staticRows({
  owner,
  items,
  icon,
  onOpenUrl,
}: {
  owner: RowOwner;
  items: readonly SidebarItem[] | undefined;
  icon: LucideIcon;
  onOpenUrl: (url: string, commit: CommitMode) => void;
}): PaletteItem[] {
  return flatten(items).map(({ item, parent }) =>
    sourceRow({ owner, item, parent, icon, onOpenUrl }),
  );
}

/**
 * A module source's rows (section or mode, by id). Enter opens a row's url
 * or runs its first run: action; the worker invalidates the source's views
 * after an action, so a sidebar section over the same module refreshes.
 */
export async function moduleRows({
  owner,
  projectId,
  icon,
  query,
  signal,
  onOpenUrl,
  onError,
}: {
  owner: RowOwner;
  projectId: string;
  icon: LucideIcon;
  query?: string;
  signal: AbortSignal;
  onOpenUrl: (url: string, commit: CommitMode) => void;
  onError: (message: string) => void;
}): Promise<PaletteItem[]> {
  const onRun = (itemId: string, action: string) => {
    void desktopApi
      .sidebarSourceRequest({
        projectId,
        sectionId: owner.id,
        requestId: crypto.randomUUID(),
        method: "action",
        itemId,
        action,
      })
      .catch((cause: unknown) =>
        onError(
          cause instanceof Error && cause.message
            ? cause.message
            : `${owner.title}: the action failed.`,
        ),
      );
  };
  return (
    await loadModuleRows({
      projectId,
      sourceId: owner.id,
      ...(query !== undefined ? { query } : {}),
      signal,
    })
  ).map(({ item, parent }) =>
    sourceRow({ owner, item, parent, icon, onOpenUrl, onRun }),
  );
}

/**
 * The rows behind a sidebar section, for its palette search: its module,
 * its static items, or its workspace source with the section's own
 * filter and sort. Sections with their own view state (a selected
 * checkout, a review filter) search what they show instead.
 */
export async function sectionRows({
  section,
  sources,
  projectId,
  memberShell,
  signal,
  onOpenUrl,
  onError,
}: {
  section: SidebarSectionConfig;
  sources: WorkspaceSources;
  projectId: string;
  /** Connected projects run no local modules (ADR 0140). */
  memberShell: boolean;
  signal: AbortSignal;
  onOpenUrl: (url: string, commit: CommitMode) => void;
  onError: (message: string) => void;
}): Promise<PaletteItem[]> {
  const owner = { id: section.id, title: section.title ?? section.type };
  const icon = Search;
  // What the section hides stays out of its search.
  const shown = (id: string) => !sidebarItemPresentation({ section, id }).hide;
  if (section.source?.module)
    return memberShell
      ? []
      : (
          await moduleRows({
            owner,
            projectId,
            icon,
            signal,
            onOpenUrl,
            onError,
          })
        ).filter((row) => shown(row.id.slice(`mode:${owner.id}:`.length)));
  const type = resolveSidebarSection(section).type;
  if (type === "custom")
    return staticRows({ owner, items: section.items, icon, onOpenUrl });
  if (!isWorkspaceSource(type)) return [];
  // A chats section scoped to the current chat lists its children.
  const scoped =
    (type === "chats" || type === "subsessions") &&
    section.source?.scope &&
    section.source.scope !== "project"
      ? "subsessions"
      : type;
  return loadSourceRows({
    sources,
    source: scoped,
    projectId,
    filter: section.source,
    signal,
    onError,
    keep: (item) => shown(item.id),
  });
}

/**
 * workspace.js palette modes as palette modes (ADR 0186). Module sources run
 * in the same local Bun process as sidebar sections; member shells, where
 * local code never runs, list only static modes.
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
  sources: WorkspaceSources;
}): Array<PaletteMode & { topLevel: boolean }> {
  const sections = sidebarSections(config);
  return (config?.palette?.modes ?? []).flatMap(
    (mode): Array<PaletteMode & { topLevel: boolean }> => {
      const section = mode.section
        ? sections.find((item) => item.id === mode.section)
        : undefined;
      // A mode over a section hidden here (when.permissions) hides with it.
      if (mode.section && !section) return [];
      const module = mode.source?.module ?? section?.source?.module;
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
      // A built-in source (chats, bookmarks, ...), directly or through a
      // section, with the mode's or section's own filter and sort.
      const listed = mode.source ?? section?.source;
      const builtin =
        listed && !listed.module && isWorkspaceSource(listed.type)
          ? listed.type
          : section && !section.source && isWorkspaceSource(section.type)
            ? section.type
            : undefined;
      if (builtin) {
        if (!projectId) return [];
        return [
          {
            ...base,
            rows: {
              kind: "load",
              key: `${projectId}:${mode.id}:${JSON.stringify(listed ?? builtin)}`,
              filtered: false,
              load: async (_query, signal) => ({
                items: await loadSourceRows({
                  sources,
                  source: builtin,
                  projectId,
                  filter: listed,
                  signal,
                  onError,
                }),
              }),
            },
          },
        ];
      }
      if (!module)
        return [
          {
            ...base,
            rows: {
              kind: "list",
              items: staticRows({
                owner,
                items: mode.items ?? section?.items,
                icon,
                onOpenUrl,
              }),
            },
          },
        ];
      if (memberShell || !projectId) return [];
      const filtered = mode.search === "source";
      return [
        {
          ...base,
          rows: {
            kind: "load",
            key: `${projectId}:${mode.id}:${module}`,
            filtered,
            debounceMs: 200,
            load: async (query, signal) => ({
              items: await moduleRows({
                owner,
                projectId,
                icon,
                ...(filtered ? { query } : {}),
                signal,
                onOpenUrl,
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
