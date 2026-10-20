import type { AppCollectionItem } from "@catamorphic/app";
import {
  Activity,
  FileCode,
  FileDiff,
  Gauge,
  GitPullRequest,
  Globe,
  LayoutGrid,
  type LucideIcon,
  MessageSquare,
  PanelTop,
  Pin,
  Server,
  Workflow as WorkflowIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { historyIdentity } from "../../shared/history.js";
import { OPEN_ACTIONS, type OpenMode } from "../../shared/open-mode.js";
import {
  PALETTE_SURFACE_KINDS,
  type PaletteSurfaceKind,
  surfaceUsageKey,
  webUsageKey,
} from "../../shared/palette.js";
import type { WorkSourceName } from "../../shared/sidebar.js";
import { SiteFavicon } from "../components/site-favicon.js";
import { lucideIcon } from "../lib/lucide-icon.js";
import {
  useWorkSourcesContext,
  type WorkSources,
} from "../sources/registry.js";
import { oneRowPerDestination, type PaletteCategory } from "./rank.js";
import type { PaletteItem } from "./types.js";
import { bareUrl, hostOf } from "./urls.js";

/** The registry action that opens a row the way the palette commits it. */
function openAction(mode: OpenMode): string {
  return OPEN_ACTIONS.find((entry) => entry.mode === mode)?.action ?? "open";
}

const urlOf = (item: AppCollectionItem): string | undefined =>
  typeof item.data?.url === "string" ? item.data.url : undefined;

/**
 * How each workspace source reads in the palette: its row id prefix (stable
 * across the old per-list rows), what the detail says, how use is counted.
 */
interface SourcePresentation {
  prefix: string;
  icon: LucideIcon;
  category: PaletteCategory;
  detail: (item: AppCollectionItem) => string | undefined;
  keywords: (item: AppCollectionItem) => string[];
  /** History identity kind, when history counts these rows. */
  history?: "workflow" | "app" | "chat" | "file";
}

const BOOKMARKS: SourcePresentation = {
  prefix: "bookmark",
  icon: Globe,
  category: "bookmark",
  detail: (item: AppCollectionItem) => {
    const url = urlOf(item);
    return url ? hostOf(url) : undefined;
  },
  keywords: (item: AppCollectionItem) => {
    const url = urlOf(item);
    return url ? [hostOf(url), bareUrl(url), "bookmark"] : ["bookmark"];
  },
};

const PRESENTATION: Record<WorkSourceName, SourcePresentation> = {
  workflows: {
    prefix: "workflow",
    icon: WorkflowIcon,
    category: "resource",
    detail: () => "Workflow",
    keywords: (item) => [item.id, "workflow", "go to", "open"],
    history: "workflow",
  },
  apps: {
    prefix: "app",
    icon: LayoutGrid,
    category: "resource",
    detail: () => "App",
    keywords: (item) => [item.id, "app", "go to", "open"],
    history: "app",
  },
  chats: {
    prefix: "session",
    icon: MessageSquare,
    category: "resource",
    detail: (item) =>
      item.data?.visibility === "archived" ? "Archived chat" : "Chat",
    keywords: (item) => [
      "chat",
      "session",
      "conversation",
      ...(item.data?.visibility === "archived" ? ["archived"] : []),
    ],
    history: "chat",
  },
  subsessions: {
    prefix: "session",
    icon: MessageSquare,
    category: "resource",
    detail: () => "Subsession",
    keywords: () => ["chat", "subsession", "delegated"],
    history: "chat",
  },
  activity: {
    prefix: "activity",
    icon: Activity,
    category: "resource",
    detail: (item) => item.description ?? "Working now",
    keywords: () => ["working", "activity", "run"],
  },
  session: {
    prefix: "session-detail",
    icon: GitPullRequest,
    category: "resource",
    detail: (item) => item.description,
    keywords: () => ["pull request", "folder"],
  },
  resources: {
    prefix: "resource",
    icon: Gauge,
    category: "resource",
    detail: (item) => item.description,
    keywords: () => [
      "process",
      "cpu",
      "memory",
      "resources",
      "activity monitor",
    ],
  },
  pinned: { ...BOOKMARKS, icon: Pin },
  bookmarks: BOOKMARKS,
  library: BOOKMARKS,
  files: {
    prefix: "file",
    icon: FileCode,
    category: "resource",
    detail: (item) =>
      typeof item.data?.path === "string" ? item.data.path : undefined,
    keywords: () => ["file"],
    history: "file",
  },
  prs: {
    prefix: "pr",
    icon: GitPullRequest,
    category: "resource",
    detail: (item) => item.description,
    keywords: (item) => [item.id, "pull request", "review"],
  },
  git: {
    prefix: "change",
    icon: FileDiff,
    category: "resource",
    // Which checkout, then what changed: a file changed in two checkouts
    // reads apart.
    detail: (item) =>
      [
        typeof item.data?.checkout === "string" ? item.data.checkout : "",
        ...(item.badges ?? []),
      ]
        .filter(Boolean)
        .join(" · "),
    keywords: () => ["change", "diff"],
  },
  remote: {
    prefix: "remote",
    icon: Server,
    category: "resource",
    detail: (item) => item.badges?.join(" · "),
    keywords: () => ["publish", "server"],
  },
  tabs: {
    prefix: "open-tab",
    icon: PanelTop,
    category: "tab",
    detail: (item) => {
      const url = urlOf(item);
      return url ? hostOf(url) : undefined;
    },
    keywords: (item) => {
      const url = urlOf(item);
      return [
        ...(url ? [hostOf(url), bareUrl(url)] : []),
        ...(typeof item.data?.path === "string" ? [item.data.path] : []),
        "tab",
        "open tab",
        "switch",
      ];
    },
  },
};

const isSurfaceKind = (kind: unknown): kind is PaletteSurfaceKind =>
  PALETTE_SURFACE_KINDS.some((surface) => surface === kind);

/**
 * An open tab's usage key is that of what it shows (its page, chat, file
 * or surface), so it ranks with that destination's use and stands in for
 * its other rows while it is open. A tab showing nothing history knows
 * (a terminal, a blank page) has none and learns nothing.
 */
function tabUsage(
  item: AppCollectionItem,
  projectId: string | undefined,
): string | undefined {
  const { kind, name, sessionId, path } = item.data ?? {};
  const url = urlOf(item);
  if (url?.startsWith("file:"))
    return historyIdentity({
      kind: "local",
      path: decodeURIComponent(new URL(url).pathname),
    });
  if (url) return webUsageKey(url);
  if (isSurfaceKind(kind)) return surfaceUsageKey(kind);
  if (!projectId) return undefined;
  if (kind === "chat" && typeof sessionId === "string")
    return historyIdentity({ kind: "chat", projectId, resource: sessionId });
  if (
    (kind === "workflow" ||
      kind === "app" ||
      kind === "run" ||
      kind === "artifact") &&
    typeof name === "string"
  )
    return historyIdentity({ kind, projectId, resource: name });
  if (kind === "editor" && typeof path === "string")
    return historyIdentity({ kind: "file", projectId, resource: path });
  return undefined;
}

/**
 * A workspace source row as a palette row: the same label, icon and
 * actions everywhere the row appears, opened through the source itself.
 */
export function sourcePaletteRow({
  source,
  item,
  sources,
  projectId,
  listed = false,
  onError,
}: {
  source: WorkSourceName;
  item: AppCollectionItem;
  sources: WorkSources;
  projectId: string | undefined;
  /** A sidebar section lists this source: its rows rank with commands. */
  listed?: boolean;
  /** Opening failed after the palette closed (the chat was deleted, ...). */
  onError: (message: string) => void;
}): PaletteItem {
  const view = PRESENTATION[source];
  const url = urlOf(item);
  const opens = Boolean(item.actions?.some((action) => action.id === "open"));
  const created =
    typeof item.data?.createdAt === "string"
      ? new Date(item.data.createdAt)
      : null;
  const label =
    source === "prs" && typeof item.data?.number === "number"
      ? `#${item.data.number} ${item.label}`
      : // Untitled chats read by when they started, so they stay apart.
        view.prefix === "session" && !item.data?.title && created
        ? `Chat ${created.toLocaleDateString()} ${created.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
        : item.label;
  const faviconUrl =
    typeof item.data?.faviconUrl === "string" ? item.data.faviconUrl : null;
  return {
    id: `${view.prefix}:${item.id}`,
    icon: lucideIcon(item.icon) ?? view.icon,
    iconNode:
      (view.category === "bookmark" || source === "tabs") && url ? (
        <SiteFavicon url={url} faviconUrl={faviconUrl} className="size-4" />
      ) : undefined,
    label,
    detail: view.detail(item),
    keywords: [label, ...view.keywords(item)],
    category: view.category,
    // Archived chats are found here, not kept in a sidebar.
    sidebar: listed && item.data?.visibility !== "archived",
    usage:
      source === "tabs"
        ? tabUsage(item, projectId)
        : url
          ? webUsageKey(url)
          : view.history && projectId
            ? historyIdentity({
                kind: view.history,
                projectId,
                resource: item.id,
              })
            : `${source}:${item.id}`,
    ...(view.category === "bookmark" ? { bookmarked: true } : {}),
    // Open tabs and an imported bookmark library are found by typing; the
    // tab strip already shows the tabs, and a library is too long a list.
    ...(source === "tabs" || source === "library" ? { searchOnly: true } : {}),
    ...(source === "tabs" && item.data?.active ? { current: true } : {}),
    disabled: !opens,
    kind: "navigate",
    run: (mode) =>
      void sources
        .execute({
          source,
          itemId: item.id,
          action: openAction(mode),
          signal: new AbortController().signal,
        })
        .catch((cause: unknown) =>
          onError(
            cause instanceof Error && cause.message
              ? cause.message
              : `Could not open ${label}.`,
          ),
        ),
  };
}

/**
 * Every openable row of a source, filtered and sorted like its section,
 * once per destination: a pinned page that is also in the imported
 * library is one row.
 */
export async function loadSourceRows({
  sources,
  source,
  projectId,
  signal,
  onError,
  archived = false,
  children = true,
  keep,
  listed = false,
}: {
  sources: WorkSources;
  source: WorkSourceName;
  projectId: string | undefined;
  signal: AbortSignal;
  onError: (message: string) => void;
  /** Chats: archived ones too. */
  archived?: boolean;
  children?: boolean;
  /** Rows a section hides (itemOverrides.hide) stay out of its search. */
  keep?: (item: AppCollectionItem) => boolean;
  /** A sidebar section lists this source (see sourcePaletteRow). */
  listed?: boolean;
}): Promise<PaletteItem[]> {
  const read = (includeArchived: boolean) =>
    sources.readAll({ source, signal, archived: includeArchived, children });
  const items = [
    ...(await read(false)),
    ...(archived && source === "chats" ? await read(true) : []),
  ];
  return oneRowPerDestination(
    items
      .filter(
        (item) =>
          (keep?.(item) ?? true) &&
          item.actions?.some((action) => action.id === "open"),
      )
      .map((item) =>
        sourcePaletteRow({ source, item, sources, projectId, listed, onError }),
      ),
  );
}

/**
 * The palette's resource rows, straight from the workspace sources: loaded
 * while the palette is open, each source as it answers, and reloaded only
 * when that source changes, so they match the sidebar without a second copy
 * of any list. Chats include archived ones (the palette is where an old
 * conversation is found) but not subsessions, which history lists.
 * Bookmarks include an imported library: a saved page ranks above the
 * same page in history.
 */
export function useSourceRows({
  names,
  listed = [],
  active,
  projectId,
  onError,
}: {
  names: readonly WorkSourceName[];
  /** The names a sidebar section lists; their rows rank with commands. */
  listed?: readonly WorkSourceName[];
  active: boolean;
  projectId: string | undefined;
  onError: (message: string) => void;
}): PaletteItem[] {
  const sources = useWorkSourcesContext();
  const key = `${projectId}:${names.join(",")}:${listed.join(",")}`;
  const listedRef = useRef(listed);
  listedRef.current = listed;
  const [state, setState] = useState<{
    key: string;
    lists: ReadonlyMap<string, { rows: PaletteItem[]; signature: string }>;
  }>({ key: "", lists: new Map() });
  const namesRef = useRef(names);
  namesRef.current = names;
  const errorRef = useRef(onError);
  errorRef.current = onError;
  useEffect(() => {
    if (!active || !projectId) return;
    const controller = new AbortController();
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const requests = new Map<string, number>();
    const load = (source: WorkSourceName) => {
      const request = (requests.get(source) ?? 0) + 1;
      requests.set(source, request);
      void loadSourceRows({
        sources,
        source,
        projectId,
        signal: controller.signal,
        onError: (message) => errorRef.current(message),
        archived: true,
        // Chats without their subsessions (history lists those); bookmarks
        // with their folders, where an imported library keeps most pages.
        children:
          source === "bookmarks" || source === "pinned" || source === "library",
        listed: listedRef.current.includes(source),
        // New Tab pages (the palette's own tabs) are not places to go.
        keep: (item) => source !== "tabs" || item.data?.kind !== "palette",
      })
        .catch((): PaletteItem[] => [])
        .then((rows) => {
          if (controller.signal.aborted || requests.get(source) !== request)
            return;
          // A beat that changed nothing keeps the rows (and their ranking).
          const signature = rows
            .map(
              (row) =>
                `${row.id}\u0000${row.label}\u0000${row.detail ?? ""}\u0000${row.usage ?? ""}\u0000${row.keywords.join(" ")}\u0000${row.current ? 1 : 0}`,
            )
            .join("\n");
          setState((current) => {
            const base = current.key === key ? current.lists : new Map();
            if (base.get(source)?.signature === signature) return current;
            const lists = new Map(base);
            lists.set(source, { rows, signature });
            return { key, lists };
          });
        });
    };
    for (const source of namesRef.current) load(source);
    const stops = namesRef.current.map(
      (source) =>
        sources.subscribe?.({
          source,
          publish: () => {
            // Chats beat often: coalesce a burst into one reload.
            clearTimeout(timers.get(source));
            timers.set(
              source,
              setTimeout(() => load(source), 250),
            );
          },
        }) ?? (() => {}),
    );
    return () => {
      controller.abort();
      for (const timer of timers.values()) clearTimeout(timer);
      for (const stop of stops) stop();
    };
  }, [active, projectId, sources, key]);
  return useMemo(
    () =>
      state.key === key
        ? names.flatMap((name) => state.lists.get(name)?.rows ?? [])
        : [],
    [state, key, names],
  );
}
