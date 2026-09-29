import { type LucideIcon, Search } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { OpenMode as CommitMode } from "../../shared/open-mode.js";
import { webUsageKey } from "../../shared/palette.js";
import type { SidebarItem } from "../../shared/sidebar.js";
import type { SidebarSourceItem } from "../../shared/sidebar-source.js";
import type {
  PaletteModeConfig,
  WorkspaceConfig,
} from "../../shared/workspace.js";
import { sidebarSections } from "../../shared/workspace.js";
import { desktopApi } from "./desktop-api.js";
import { lucideIcon } from "./lucide-icon.js";
import type { PaletteCategory } from "./palette-search.js";

export interface PaletteItem {
  id: string;
  icon: LucideIcon;
  iconNode?: ReactNode;
  label: string;
  /** Muted inline text, e.g. a URL host or the item's type. */
  detail?: string;
  keywords: string[];
  /** Preformatted chip, e.g. "⌘B". */
  shortcut?: string;
  /**
   * Choice rows: this row IS the active choice (current model/agent/
   * effort). Renders a quiet check + "current" chip on the right, and a
   * "pin-current" list opens with it first (normal ranking while searching).
   */
  current?: boolean;
  /** Web rows saved as bookmarks carry a star at the right edge. */
  bookmarked?: boolean;
  /**
   * Scope label rendered above this row when the previous row carries a
   * different group (e.g. "Project agents" in the agent pickers).
   */
  group?: string;
  /** Unusable rows (invalid project agents): visible, never committable. */
  disabled?: boolean;
  /** Navigate items load something tab-shaped and honor the commit mode. */
  kind: "action" | "navigate";
  /** What the row is, for ranking (ADR 0186). Defaults to command. */
  category?: PaletteCategory;
  /**
   * Usage key: frecency and learned picks. History identities for pages
   * and project resources, `surface:<kind>` for surfaces, else the row's
   * own stable key. Rows without one never learn.
   */
  usage?: string;
  /**
   * How committing behaves. "stay" swaps palette state in place (entering
   * a mode, retrying a load). "answer" answers the active mode's question
   * and puts the palette away. Default: an ordinary commit.
   */
  commit?: "stay" | "answer";
  run: (mode: CommitMode) => void;
}

/**
 * Where a mode's rows come from. "list" rows are ranked by the palette as
 * the user types. "compute" rows are the mode's own answer to the query
 * (input modes, choice lists with custom rows). "load" rows are fetched:
 * once per entry and then ranked (filtered: false), or per query with the
 * source doing the search (filtered: true).
 */
export type PaletteRows =
  | {
      kind: "list";
      items: readonly PaletteItem[];
      /** Unfiltered order: as given, or the current choice first. */
      zero?: "given" | "pin-current";
    }
  | { kind: "compute"; rows: (query: string) => PaletteItem[] }
  | {
      kind: "load";
      /** Changing it reloads (project switch, a new sidebar search). */
      key: string;
      filtered: boolean;
      /** Shown instead of loading while a filtered mode has no query. */
      idle?: string;
      /** Shown when the source returns nothing. */
      empty?: string;
      debounceMs?: number;
      load: (query: string, signal: AbortSignal) => Promise<PaletteLoad>;
    };
export interface PaletteLoad {
  items: PaletteItem[];
  /** A quiet line above the rows, e.g. "Showing the first 80 matches". */
  notice?: string;
}

/**
 * A palette mode: one chip, one question, one list of rows. Built-in
 * modes, choice pickers, sidebar searches and workspace.js modes all take
 * this shape; typed names enter it, Backspace on empty input leaves it.
 */
export interface PaletteMode {
  id: string;
  chip: string;
  icon: LucideIcon;
  placeholder: string;
  /** Typed names, trigger first. Absent: entered only by a command. */
  names?: readonly string[];
  /** The @ list's row. */
  label?: string;
  description?: string;
  rows: PaletteRows;
}

/** "@se", "se" or "chat" → one mode, once unambiguous. */
export function matchPaletteMode(
  modes: readonly PaletteMode[],
  input: string,
): PaletteMode | undefined {
  const raw = (input.startsWith("@") ? input.slice(1) : input).toLowerCase();
  if (!raw) return undefined;
  const exact = modes.find((mode) => mode.names?.includes(raw));
  if (exact) return exact;
  const matches = modes.filter((mode) =>
    mode.names?.some((name) => name.startsWith(raw)),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

export function isFullPaletteModeName(
  modes: readonly PaletteMode[],
  input: string,
): boolean {
  const raw = input.toLowerCase();
  return modes.some((mode) => mode.names?.includes(raw));
}

export interface PaletteLoadState {
  items: PaletteItem[];
  notice?: string;
  loading: boolean;
  error: string | null;
  idle: boolean;
  retry: () => void;
}

/**
 * Runs a "load" mode's source: debounced per query for filtered sources,
 * once per key otherwise. Aborts superseded loads so a slow answer never
 * replaces a newer one.
 */
export function usePaletteLoad(
  rows: PaletteRows | undefined,
  query: string,
  active: boolean,
): PaletteLoadState {
  const load = rows?.kind === "load" ? rows : undefined;
  const filteredQuery = load?.filtered ? query.trim() : "";
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{
    token: string;
    key: string;
    result: PaletteLoad | null;
    error: string | null;
  }>({ token: "", key: "", result: null, error: null });
  const token = load ? JSON.stringify([load.key, filteredQuery, attempt]) : "";
  const idle = Boolean(load?.filtered && !filteredQuery && load.idle);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the token captures key, query and retry; load closures change every render
  useEffect(() => {
    if (!active || !load || idle) return;
    const controller = new AbortController();
    const key = load.key;
    const timer = window.setTimeout(
      () => {
        void load
          .load(filteredQuery, controller.signal)
          .then((result) => {
            if (!controller.signal.aborted)
              setState({ token, key, result, error: null });
          })
          .catch((cause: unknown) => {
            if (!controller.signal.aborted)
              setState({
                token,
                key,
                result: null,
                error:
                  cause instanceof Error && cause.message
                    ? cause.message
                    : "Could not load these results.",
              });
          });
      },
      load.filtered && filteredQuery ? (load.debounceMs ?? 150) : 0,
    );
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [active, token, idle]);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  const loadKey = load?.key;
  return useMemo(() => {
    const current = state.token === token ? state : null;
    // The previous query's rows stay while the next query loads, so
    // typing refines a list instead of flashing a loading row.
    const shown =
      current?.result ?? (state.key === loadKey ? state.result : null);
    return {
      items: shown?.items ?? [],
      notice: shown?.notice,
      loading: Boolean(loadKey) && !idle && !current,
      error: current?.error ?? null,
      idle,
      retry,
    };
  }, [state, token, loadKey, idle, retry]);
}

/** A source row as a palette row: open its url, else run its first command. */
function sourceRow({
  mode,
  item,
  parent,
  icon,
  onOpenUrl,
  onRun,
}: {
  mode: PaletteModeConfig;
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
    id: `mode:${mode.id}:${item.id}`,
    icon: lucideIcon(item.icon) ?? icon,
    label: item.label,
    detail: item.description ?? parent,
    keywords: [...(item.keywords ?? []), ...(item.badges ?? [])],
    category: "resource",
    usage: url ? webUsageKey(url) : `mode:${mode.id}:${item.id}`,
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
}: {
  config: WorkspaceConfig | null;
  projectId: string | undefined;
  memberShell: boolean;
  onOpenUrl: (url: string, commit: CommitMode) => void;
  /** A row's action failed after the palette closed. */
  onError: (message: string) => void;
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
      if (!module) {
        const items = flatten(mode.items ?? section?.items).map(
          ({ item, parent }) =>
            sourceRow({ mode, item, parent, icon, onOpenUrl }),
        );
        return [{ ...base, rows: { kind: "list", items } }];
      }
      if (memberShell || !projectId) return [];
      // The worker invalidates the source's views after an action, so a
      // sidebar section over the same module refreshes on its own.
      const onRun = (itemId: string, action: string) => {
        void desktopApi
          .sidebarSourceRequest({
            projectId,
            sectionId: mode.id,
            requestId: crypto.randomUUID(),
            method: "action",
            itemId,
            action,
          })
          .catch((cause: unknown) =>
            onError(
              cause instanceof Error && cause.message
                ? cause.message
                : `${mode.title}: the action failed.`,
            ),
          );
      };
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
              items: (
                await loadModuleRows({
                  projectId,
                  sourceId: mode.id,
                  ...(filtered ? { query } : {}),
                  signal,
                })
              ).map(({ item, parent }) =>
                sourceRow({ mode, item, parent, icon, onOpenUrl, onRun }),
              ),
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
