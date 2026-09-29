import type { AppCollectionItem } from "@catamorphic/app";
import {
  FileCode,
  FileDiff,
  GitPullRequest,
  Globe,
  LayoutGrid,
  type LucideIcon,
  MessageSquare,
  PanelTop,
  Workflow as WorkflowIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { historyIdentity } from "../../shared/history.js";
import { OPEN_ACTIONS, type OpenMode } from "../../shared/open-mode.js";
import { webUsageKey } from "../../shared/palette.js";
import type { SidebarSource } from "../../shared/sidebar.js";
import type { WorkspaceSourceName } from "../../shared/workspace-config.js";
import { SiteFavicon } from "../components/site-favicon.js";
import { lucideIcon } from "../lib/lucide-icon.js";
import {
  projectSourceItems,
  useWorkspaceSourcesContext,
  type WorkspaceSources,
} from "../lib/workspace-sources.js";
import type { PaletteCategory } from "./rank.js";
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
const PRESENTATION: Record<
  WorkspaceSourceName,
  {
    prefix: string;
    icon: LucideIcon;
    category: PaletteCategory;
    detail: (item: AppCollectionItem) => string | undefined;
    keywords: (item: AppCollectionItem) => string[];
    /** History identity kind, when history counts these rows. */
    history?: "workflow" | "app" | "chat" | "file";
  }
> = {
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
    prefix: "session",
    icon: MessageSquare,
    category: "resource",
    detail: (item) => item.description ?? "Working chat",
    keywords: () => ["chat", "working", "activity"],
    history: "chat",
  },
  bookmarks: {
    prefix: "bookmark",
    icon: Globe,
    category: "bookmark",
    detail: (item) => {
      const url = urlOf(item);
      return url ? hostOf(url) : undefined;
    },
    keywords: (item) => {
      const url = urlOf(item);
      return url ? [hostOf(url), bareUrl(url), "bookmark"] : ["bookmark"];
    },
  },
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
    detail: (item) => item.badges?.join(" · "),
    keywords: () => ["change", "diff"],
  },
  remote: {
    prefix: "remote",
    icon: FileCode,
    category: "resource",
    detail: (item) => item.badges?.join(" · "),
    keywords: () => ["publish", "server"],
  },
  tabs: {
    prefix: "open-tab",
    icon: PanelTop,
    category: "resource",
    detail: () => "Open tab",
    keywords: () => ["tab"],
  },
};

/**
 * A workspace source row as a palette row: the same label, icon and
 * actions everywhere the row appears, opened through the source itself.
 */
export function sourcePaletteRow({
  source,
  item,
  sources,
  projectId,
}: {
  source: WorkspaceSourceName;
  item: AppCollectionItem;
  sources: WorkspaceSources;
  projectId: string | undefined;
}): PaletteItem {
  const view = PRESENTATION[source];
  const url = urlOf(item);
  const opens = Boolean(item.actions?.some((action) => action.id === "open"));
  const label =
    source === "prs" && typeof item.data?.number === "number"
      ? `#${item.data.number} ${item.label}`
      : item.label;
  return {
    id: `${view.prefix}:${item.id}`,
    icon: lucideIcon(item.icon) ?? view.icon,
    iconNode:
      source === "bookmarks" && url ? (
        <SiteFavicon url={url} className="size-4" />
      ) : undefined,
    label,
    detail: view.detail(item),
    keywords: [label, ...view.keywords(item)],
    category: view.category,
    usage: url
      ? webUsageKey(url)
      : view.history && projectId
        ? historyIdentity({ kind: view.history, projectId, resource: item.id })
        : `${source}:${item.id}`,
    ...(source === "bookmarks" ? { bookmarked: true } : {}),
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
        .catch(() => {}),
  };
}

/** Every openable row of a source, filtered and sorted like its section. */
export async function loadSourceRows({
  sources,
  source,
  projectId,
  filter,
  signal,
  archived = false,
}: {
  sources: WorkspaceSources;
  source: WorkspaceSourceName;
  projectId: string | undefined;
  filter?: SidebarSource;
  signal: AbortSignal;
  archived?: boolean;
}): Promise<PaletteItem[]> {
  const read = async (includeArchived: boolean) =>
    sources.readAll({ source, signal, archived: includeArchived });
  const items = [
    ...(await read(false)),
    ...(archived && source === "chats" ? await read(true) : []),
  ];
  return projectSourceItems(items, filter)
    .filter((item) => item.actions?.some((action) => action.id === "open"))
    .map((item) => sourcePaletteRow({ source, item, sources, projectId }));
}

/**
 * The palette's resource rows, straight from the workspace sources: loaded
 * while the palette is open and refreshed when a source changes, so they
 * match the sidebar without a second copy of any list. Chats include the
 * archived ones: the palette is where an old conversation is found.
 */
export function useSourceRows({
  names,
  active,
  projectId,
}: {
  names: readonly WorkspaceSourceName[];
  active: boolean;
  projectId: string | undefined;
}): PaletteItem[] {
  const sources = useWorkspaceSourcesContext();
  const key = `${projectId}:${names.join(",")}`;
  const [state, setState] = useState<{
    key: string;
    lists: ReadonlyMap<string, PaletteItem[]>;
  }>({ key: "", lists: new Map() });
  const namesRef = useRef(names);
  namesRef.current = names;
  useEffect(() => {
    if (!active || !projectId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => {
      void Promise.all(
        namesRef.current.map(
          async (source): Promise<[string, PaletteItem[]]> => {
            try {
              const rows = await loadSourceRows({
                sources,
                source,
                projectId,
                signal: controller.signal,
                archived: true,
              });
              return [source, rows];
            } catch {
              // One unavailable source (no profile, no permission) leaves
              // the others listed.
              return [source, []];
            }
          },
        ),
      ).then((entries) => {
        if (!controller.signal.aborted)
          setState({ key, lists: new Map(entries) });
      });
    };
    load();
    // Chats change with every turn: coalesce a burst into one reload.
    const reload = () => {
      clearTimeout(timer);
      timer = setTimeout(load, 250);
    };
    const stops = namesRef.current.map(
      (source) =>
        sources.subscribe?.({ source, publish: reload }) ?? (() => {}),
    );
    return () => {
      controller.abort();
      clearTimeout(timer);
      for (const stop of stops) stop();
    };
  }, [active, projectId, sources, key]);
  return useMemo(
    () =>
      state.key === key
        ? names.flatMap((name) => state.lists.get(name) ?? [])
        : [],
    [state, key, names],
  );
}
