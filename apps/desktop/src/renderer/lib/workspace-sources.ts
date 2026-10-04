import type { AppCollectionItem, AppCollections } from "@catamorphic/app";
import { useCatamorphic, workflowKeys } from "@catamorphic/react";
import type { AgentSession } from "@catamorphic/react/types";
import { useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  createElement,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
} from "react";
import {
  OPEN_ACTIONS,
  type OpenMode,
  openModeForAction,
} from "../../shared/open-mode.js";
import type { SidebarSource, SidebarSurface } from "../../shared/sidebar.js";
import { isWorkspaceSource } from "../../shared/workspace-config.js";
import { buildTree, isVisibleProjectFile } from "../components/files-nav.js";
import { appsQuery } from "./apps.js";
import { desktopApi } from "./desktop-api.js";
import {
  readSidebarSessionPage,
  subscribeSidebarSessions,
} from "./sidebar-sessions.js";
import { tabKey, type WorkspaceTab } from "./workspace-types.js";

/**
 * The one data layer for workspace lists (ADR 0186). Sidebar app widgets
 * (through their grants), palette resources, section searches and palette
 * modes all read the same sources, and the built-in sidebar sections share
 * their query caches, so a list loads, refreshes and opens one way.
 */
export interface WorkspaceSources extends AppCollections {
  read: (
    request: Parameters<AppCollections["read"]>[0] & {
      /** Chats only: archived chats instead of promoted ones. */
      archived?: boolean;
      /** Internal: false for search reads, which no subscriber watches. */
      track?: boolean;
    },
  ) => ReturnType<AppCollections["read"]>;
  /**
   * Every row of a source, roots then children, bounded and unique; for
   * search. Search reads are not live views, so they do not register for
   * a subscriber's branch invalidations.
   */
  readAll: (request: {
    source: string;
    signal: AbortSignal;
    archived?: boolean;
    /** Walk into rows with children (default true). */
    children?: boolean;
    limit?: number;
  }) => Promise<AppCollectionItem[]>;
}

/** Lucide icon per tab kind, for tab rows outside the tab strip. */
const TAB_ICONS: Partial<Record<WorkspaceTab["kind"], string>> = {
  browser: "Globe",
  chat: "MessageSquare",
  terminal: "SquareTerminal",
  editor: "FileCode",
  workflow: "Workflow",
  app: "LayoutGrid",
  run: "Play",
  diff: "FileDiff",
  settings: "Settings",
  "profile-settings": "Settings",
  history: "History",
  sites: "SlidersHorizontal",
  passwords: "KeyRound",
  downloads: "Download",
  usage: "ChartColumn",
};

export function useWorkspaceSources({
  projectId,
  profileId,
  tabs,
  activeTabKey,
  onFocusTab,
  onOpenUrl,
  surface,
  writesProgram,
  onOpenSession,
  onOpenTab,
  onOpenFile,
  onSessionAction,
}: {
  projectId: string;
  profileId?: string;
  /** Every open tab, in strip order. */
  tabs: readonly WorkspaceTab[];
  /** The tab in front (a floating one first). */
  activeTabKey: string | undefined;
  /** Bring an open tab to the front, tile it beside, or float it. */
  onFocusTab: (key: string, mode?: OpenMode) => void;
  onOpenUrl: (url: string, mode?: OpenMode) => void;
  surface: SidebarSurface;
  /** Whether the viewer edits the program (`program:write`): Git sources and program files. */
  writesProgram: boolean;
  onOpenSession: (session: AgentSession, mode?: OpenMode) => void;
  onOpenTab: (tab: WorkspaceTab, mode?: OpenMode) => void;
  onOpenFile: (path: string, mode?: OpenMode) => void;
  onSessionAction: (
    id: string,
    action: "archive" | "mark-read" | "mark-unread",
  ) => void;
}): WorkspaceSources {
  const { apiClient } = useCatamorphic();
  const queryClient = useQueryClient();
  const actions = useRef({
    onOpenSession,
    onOpenTab,
    onFocusTab,
    onOpenFile,
    onSessionAction,
    onOpenUrl,
    tabs,
    activeTabKey,
  });
  actions.current = {
    onOpenSession,
    onOpenTab,
    onFocusTab,
    onOpenFile,
    onSessionAction,
    onOpenUrl,
    tabs,
    activeTabKey,
  };
  const tabListeners = useRef(new Set<() => void>());
  // The strip is rebuilt every render: only what a tab row shows (or which
  // tab is in front) changing refreshes the source.
  const tabsSignature = [
    activeTabKey,
    ...tabs.map((tab) =>
      [
        tabKey(tab),
        tab.label,
        tab.detail,
        tab.bookmarkUrl,
        tab.kind === "browser" ? tab.faviconUrl : "",
        tab.kind === "chat" ? tab.sessionId : "",
        tab.groupId,
      ].join("\u0000"),
    ),
  ].join("\n");
  const previousTabs = useRef(tabsSignature);
  useEffect(() => {
    if (previousTabs.current === tabsSignature) return;
    previousTabs.current = tabsSignature;
    for (const listener of tabListeners.current) listener();
  }, [tabsSignature]);
  return useMemo(() => {
    const sessions = new Map<string, AgentSession>();
    const openers = new Map<string, (mode?: OpenMode) => void>();
    const admitted = new Map<string, Map<string, AppCollectionItem>>();
    const loadedParents = new Map<string, Set<string | null>>();
    // Git reads the program's checkouts: only for people who edit it.
    const requireSource = (source: string) => {
      if (!isWorkspaceSource(source))
        throw new Error(`Source ${source} has no collection adapter`);
      if (!writesProgram && source === "git")
        throw new Error(`Source ${source} is not available here`);
    };
    const result: WorkspaceSources = {
      readAll: async ({
        source,
        signal,
        archived,
        children = true,
        limit = 1000,
      }) => {
        const rows = new Map<string, AppCollectionItem>();
        const queue: Array<string | null> = [null];
        // Activity already lists running children beside their parents.
        const walk = children && source !== "activity";
        // Bookmark folders read one in-memory tree; other sources may call
        // the server per page.
        const pageBudget = source === "bookmarks" ? limit : 50;
        let pages = 0;
        while (queue.length && rows.size < limit && pages < pageBudget) {
          const parentId = queue.shift() ?? null;
          let cursor: string | undefined;
          do {
            pages += 1;
            const page = await result.read({
              source,
              parentId,
              cursor,
              signal,
              archived,
              track: false,
            });
            for (const item of page.items) {
              if (rows.has(item.id)) continue;
              rows.set(item.id, item);
              if (walk && item.hasChildren) queue.push(item.id);
            }
            // A page can be empty after filtering and still have more.
            cursor = page.cursor;
          } while (cursor && rows.size < limit && pages < pageBudget);
        }
        return [...rows.values()].slice(0, limit);
      },
      read: async ({
        source,
        parentId,
        cursor,
        signal,
        archived,
        track = true,
      }) => {
        requireSource(source);
        const offset = cursor ? Number(cursor) : 0;
        if (!Number.isSafeInteger(offset) || offset < 0)
          throw new Error("Invalid collection cursor");
        let items: AppCollectionItem[] = [];
        let next: string | undefined;
        if (
          source === "chats" ||
          source === "subsessions" ||
          source === "activity"
        ) {
          const parent =
            parentId ??
            (source === "subsessions" ? surface.sessionId : undefined);
          if (source === "subsessions" && !parent) return { items: [] };
          const page = await readSidebarSessionPage({
            apiClient,
            client: queryClient,
            projectId,
            signal,
            query: {
              limit: 50,
              offset,
              ...(source === "chats"
                ? { visibility: archived ? "archived" : "promoted" }
                : {}),
              ...(parent
                ? { parentSessionId: parent }
                : source === "activity"
                  ? {}
                  : { rootsOnly: "true" }),
            },
          });
          items = page.items
            .filter(
              (session) =>
                (session.visibility !== "archived" || archived) &&
                (source !== "activity" ||
                  session.running ||
                  session.attentionRequired),
            )
            .map((session) => {
              sessions.set(session.id, session);
              return {
                id: session.id,
                parentId,
                hasChildren: Boolean(session.childCount),
                label: session.title ?? "Untitled chat",
                description: session.activity ?? undefined,
                icon: "MessageSquare",
                badges: [
                  ...(session.owner === "project" ? ["Project"] : []),
                  ...(session.attentionRequired
                    ? ["Needs you"]
                    : session.running
                      ? ["Working"]
                      : []),
                ],
                actions: [
                  { id: "open", label: "Open chat" },
                  { id: "archive", label: "Archive", icon: "Archive" },
                  { id: "mark-read", label: "Mark as read" },
                  { id: "mark-unread", label: "Mark as unread" },
                ],
                // The record itself: filters and sorts compare the same
                // fields the sidebar section does (source.filter).
                data: { ...session },
              };
            });
          if (offset + page.items.length < page.total)
            next = String(offset + page.items.length);
        } else if (source === "files") {
          const files = await queryClient.fetchQuery({
            queryKey: ["desktop", "local-files", projectId],
            queryFn: () => desktopApi.projectLocalFiles(projectId),
            staleTime: 1000,
          });
          const tree = buildTree(
            files
              .map((file) => file.path)
              .filter((path) => isVisibleProjectFile(path, !writesProgram)),
          );
          const all: AppCollectionItem[] = [];
          const visit = (
            nodes: ReturnType<typeof buildTree>,
            parent: string | null,
          ) => {
            for (const node of nodes) {
              if (parent === (parentId ?? null))
                all.push({
                  id: node.path,
                  parentId: parent,
                  hasChildren: Boolean(node.children),
                  label: node.name,
                  icon: node.children ? "Folder" : "File",
                  actions: node.children
                    ? []
                    : [{ id: "open", label: "Open file" }],
                  data: { path: node.path },
                });
              if (node.children) visit(node.children, node.path);
            }
          };
          visit(tree, null);
          items = all.slice(offset, offset + 100);
          if (offset + 100 < all.length) next = String(offset + 100);
        } else if (source === "workflows") {
          // The sidebar's Workflows section reads this same cache.
          const workflows = await queryClient.fetchQuery({
            queryKey: workflowKeys.list({ projectId, ref: undefined }),
            staleTime: 1000,
            // The query's own signal: one reader leaving must not fail the
            // shared request the sidebar is waiting on.
            queryFn: async ({ signal: querySignal }) => {
              const response = await apiClient.GET(
                "/api/projects/{projectId}/workflows",
                {
                  params: { path: { projectId }, query: {} },
                  signal: querySignal,
                },
              );
              if (!response.data) throw new Error("Could not read workflows");
              return response.data;
            },
          });
          items = workflows.map((workflow) => ({
            id: workflow.name,
            label: workflow.displayName ?? workflow.name,
            icon: "Workflow",
            actions: [{ id: "open", label: "Open workflow" }],
            data: { ...workflow },
          }));
        } else if (source === "apps") {
          const apps = await queryClient.fetchQuery({
            ...appsQuery({ apiClient, projectId }),
            staleTime: 1000,
          });
          items = apps.map((app) => ({
            id: app.name,
            label: app.title,
            icon: app.icon,
            actions: [{ id: "open", label: "Open app" }],
            data: { ...app },
          }));
        } else if (source === "prs") {
          const prs = await desktopApi.prList(projectId);
          items = prs.map((pr) => ({
            id: String(pr.number),
            label: pr.title,
            description: pr.author,
            icon: "GitPullRequest",
            actions: [{ id: "open", label: "Open review" }],
            data: { number: pr.number, author: pr.author, title: pr.title },
          }));
        } else if (source === "git") {
          const overview = await desktopApi.gitOverview(
            projectId,
            parentId ? [parentId] : [],
            surface.sessionId,
          );
          if (overview.error) throw new Error(overview.error);
          if (!parentId)
            items = overview.worktrees.map((tree) => ({
              id: tree.path,
              label: tree.branch ?? tree.path,
              icon: "GitBranch",
              hasChildren: true,
            }));
          else {
            const tree = overview.worktrees.find(
              (tree) => tree.path === parentId,
            );
            if (tree?.error) throw new Error(tree.error);
            items = [
              ...(tree?.changes ?? []),
              ...(tree?.branchChanges ?? []),
            ].map((file) => {
              const id = `${parentId}:${file.mode}:${file.path}`;
              openers.set(`git:${id}`, (mode) =>
                actions.current.onOpenTab(
                  {
                    kind: "diff",
                    name: id,
                    projectId,
                    source: {
                      type: "local",
                      worktreePath: parentId,
                      filePath: file.path,
                      mode: file.mode,
                      previousPath: file.previousPath,
                      baseRef: tree?.baseRef,
                    },
                  },
                  mode,
                ),
              );
              return {
                id,
                parentId,
                label: file.path,
                icon: "FileDiff",
                badges: [file.kind, file.mode],
                actions: [{ id: "open", label: "Open changes" }],
              };
            });
          }
        } else if (source === "bookmarks") {
          if (!profileId)
            throw new Error("A profile is required for bookmarks");
          // One read serves every folder of a walk.
          const data = await queryClient.fetchQuery({
            queryKey: ["desktop", "bookmarks", profileId, projectId],
            staleTime: 1000,
            queryFn: () => desktopApi.bookmarksGet({ projectId, profileId }),
          });
          const nodes: AppCollectionItem[] = [];
          for (const [scope, group] of Object.entries(data)) {
            if (!group) continue;
            for (const folder of group.folders)
              nodes.push({
                id: `${scope}:${folder.id}`,
                parentId: folder.parentId
                  ? `${scope}:${folder.parentId}`
                  : null,
                label: folder.label,
                icon: "Folder",
                hasChildren: true,
              });
            for (const bookmark of group.bookmarks) {
              const id = `${scope}:${bookmark.id}`;
              openers.set(`bookmarks:${id}`, (mode) =>
                actions.current.onOpenUrl(bookmark.url, mode),
              );
              nodes.push({
                id,
                parentId: bookmark.folderId
                  ? `${scope}:${bookmark.folderId}`
                  : null,
                label: bookmark.label,
                icon: "Bookmark",
                description: bookmark.url,
                actions: [
                  { id: "open", label: "Open bookmark" },
                  { id: "copy-url", label: "Copy URL" },
                ],
                data: {
                  url: bookmark.url,
                  faviconUrl: bookmark.faviconUrl ?? null,
                  scope,
                },
              });
            }
          }
          items = nodes.filter(
            (item) => (item.parentId ?? null) === (parentId ?? null),
          );
        } else if (source === "remote") {
          const status = await desktopApi.remoteStatus(projectId);
          items = status
            ? [
                ...status.local.modified.map((path) => ({
                  path,
                  deleted: false,
                })),
                ...status.local.deleted.map((path) => ({
                  path,
                  deleted: true,
                })),
              ].map(({ path, deleted }) => {
                openers.set(`remote:${path}`, (mode) =>
                  actions.current.onOpenFile(path, mode),
                );
                return {
                  id: path,
                  label: path,
                  icon: "File",
                  badges: [deleted ? "Deleted" : "Modified"],
                  actions: deleted ? [] : [{ id: "open", label: "Open file" }],
                };
              })
            : [];
        } else if (source === "tabs") {
          const { tabs: open, activeTabKey: front } = actions.current;
          items = open.map((tab) => {
            const id = tabKey(tab);
            openers.set(`tabs:${id}`, (mode) =>
              actions.current.onFocusTab(id, mode),
            );
            return {
              id,
              label: tab.label ?? tab.name,
              icon: TAB_ICONS[tab.kind] ?? "PanelTop",
              description: tab.detail,
              parentId: tab.groupId ?? null,
              actions: [{ id: "open", label: "Switch to tab" }],
              data: {
                kind: tab.kind,
                name: tab.name,
                active: id === front,
                ...(tab.kind === "browser"
                  ? { url: tab.bookmarkUrl, faviconUrl: tab.faviconUrl ?? null }
                  : {}),
                ...(tab.kind === "chat" && tab.sessionId
                  ? { sessionId: tab.sessionId }
                  : {}),
                ...(tab.kind === "editor" && tab.detail
                  ? { path: tab.detail }
                  : {}),
              },
            };
          });
        }
        items = items.map((item) =>
          item.actions?.some((action) => action.id === "open")
            ? {
                ...item,
                actions: [
                  ...item.actions,
                  ...OPEN_ACTIONS.map((action) => ({
                    id: action.action,
                    label: action.label,
                  })),
                ],
              }
            : item,
        );
        signal.throwIfAborted();
        if (track) {
          const parents = loadedParents.get(source) ?? new Set<string | null>();
          parents.add(parentId ?? null);
          loadedParents.set(source, parents);
        }
        const known = admitted.get(source) ?? new Map();
        for (const item of items) known.set(item.id, item);
        admitted.set(source, known);
        return { items, cursor: next };
      },
      execute: async ({ source, itemId, action, signal }) => {
        requireSource(source);
        signal.throwIfAborted();
        const mode = openModeForAction(action);
        const item = admitted.get(source)?.get(itemId);
        if (
          !item?.actions?.some(
            (entry) => entry.id === action && !entry.disabledReason,
          )
        )
          throw new Error("This item does not support that action");
        if (["chats", "subsessions", "activity"].includes(source)) {
          const session = sessions.get(itemId);
          if (!session) throw new Error("Session is no longer available");
          if (action === "open" || mode)
            actions.current.onOpenSession(session, mode);
          else if (
            action === "archive" ||
            action === "mark-read" ||
            action === "mark-unread"
          )
            actions.current.onSessionAction(itemId, action);
        } else if (
          source === "bookmarks" &&
          action === "copy-url" &&
          typeof item.data?.url === "string"
        )
          await navigator.clipboard.writeText(item.data.url);
        else if (openers.has(`${source}:${itemId}`))
          openers.get(`${source}:${itemId}`)?.(mode);
        else if (source === "files") actions.current.onOpenFile(itemId, mode);
        else if (source === "workflows")
          actions.current.onOpenTab({ kind: "workflow", name: itemId }, mode);
        else if (source === "apps")
          actions.current.onOpenTab({ kind: "app", name: itemId }, mode);
        else if (source === "prs")
          actions.current.onOpenTab(
            {
              kind: "diff",
              name: `review:${itemId}`,
              projectId,
              source: { type: "review", prNumber: Number(itemId) },
            },
            mode,
          );
      },
      subscribe: ({ source, publish }) => {
        requireSource(source);
        const refresh = () => {
          for (const parentId of loadedParents.get(source) ?? [null])
            publish(
              parentId === null
                ? { type: "invalidate" }
                : { type: "invalidate", parentId },
            );
        };
        if (source === "tabs") tabListeners.current.add(refresh);
        const native = [
          "git",
          "files",
          "remote",
          "workflows",
          "apps",
          "prs",
        ].includes(source)
          ? desktopApi.onGitChanged((change) => {
              if (change.projectId !== projectId) return;
              // Program files changed: the shared lists are stale now.
              void queryClient.invalidateQueries({
                queryKey: workflowKeys.project({ projectId }),
              });
              void queryClient.invalidateQueries({
                queryKey: ["cat", "project", projectId, "apps"],
              });
              refresh();
            })
          : () => {};
        const sessions = ["chats", "subsessions", "activity"].includes(source)
          ? subscribeSidebarSessions({
              client: queryClient,
              projectId,
              listener: refresh,
            })
          : () => {};
        const bookmarks =
          source === "bookmarks"
            ? desktopApi.onBookmarksChanged((change) => {
                if (
                  change.profileId !== profileId ||
                  (change.projectId && change.projectId !== projectId)
                )
                  return;
                queryClient.removeQueries({
                  queryKey: ["desktop", "bookmarks", profileId],
                });
                refresh();
              })
            : () => {};
        return () => {
          tabListeners.current.delete(refresh);
          native();
          sessions();
          bookmarks();
        };
      },
    };
    return result;
  }, [
    apiClient,
    queryClient,
    projectId,
    profileId,
    surface.sessionId,
    writesProgram,
  ]);
}

/** A widget sees only the sources its section grants (ADR 0102). */
export function grantSources(
  sources: WorkspaceSources,
  granted: readonly string[] | undefined,
): AppCollections {
  const allowed = new Set(granted ?? []);
  const require = (source: string) => {
    if (!allowed.has(source))
      throw new Error(`Source ${source} is not granted to this widget`);
  };
  return {
    read: async (request) => {
      require(request.source);
      return sources.read(request);
    },
    execute: async (request) => {
      require(request.source);
      return sources.execute(request);
    },
    subscribe: (request) => {
      require(request.source);
      return sources.subscribe?.(request) ?? (() => {});
    },
  };
}

/**
 * source.filter and source.sort over loaded rows. Fields resolve on the
 * row's data first (a chat's running, a PR's author), then the row itself.
 */
export function projectSourceItems<
  T extends { data?: Record<string, unknown> },
>(items: readonly T[], source: SidebarSource | undefined): T[] {
  const read = (item: T, field: string): unknown => {
    let value: unknown = { ...item, ...item.data };
    for (const part of field.split(".")) {
      if (!value || typeof value !== "object") return undefined;
      value = Object.entries(value).find(([key]) => key === part)?.[1];
    }
    return value;
  };
  const filtered = items.filter((item) =>
    Object.entries(source?.filter ?? {}).every(
      ([field, value]) => read(item, field) === value,
    ),
  );
  const sort = source?.sort;
  return sort
    ? filtered.sort((left, right) => {
        const a = read(left, sort.field);
        const b = read(right, sort.field);
        const order =
          typeof a === "number" && typeof b === "number"
            ? a - b
            : String(a ?? "").localeCompare(String(b ?? ""));
        return order * (sort.direction === "desc" ? -1 : 1);
      })
    : filtered;
}

const WorkspaceSourcesContext = createContext<WorkspaceSources | null>(null);

export function WorkspaceSourcesProvider({
  value,
  children,
}: {
  value: WorkspaceSources;
  children: ReactNode;
}) {
  return createElement(WorkspaceSourcesContext.Provider, { value }, children);
}

export function useWorkspaceSourcesContext(): WorkspaceSources {
  const sources = useContext(WorkspaceSourcesContext);
  if (!sources)
    throw new Error("Workspace lists need a WorkspaceSourcesProvider.");
  return sources;
}
