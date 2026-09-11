import type { AppCollectionItem, AppCollections } from "@catamorphic/app";
import { useCatamorphic } from "@catamorphic/react";
import type { AgentSession } from "@catamorphic/react/types";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";
import {
  OPEN_ACTIONS,
  type OpenMode,
  openModeForAction,
} from "../../shared/open-mode.js";
import type { SidebarSurface } from "../../shared/sidebar.js";
import { buildTree, isVisibleProjectFile } from "../components/files-nav.js";
import type { WorkspaceTab } from "../components/workspace-tabs.js";
import { desktopApi } from "./desktop-api.js";
import { subscribeSidebarSessions } from "./sidebar-sessions.js";

export function useSidebarAppCollections({
  projectId,
  profileId,
  tabs,
  onOpenUrl,
  granted,
  surface,
  builder,
  onOpenSession,
  onOpenTab,
  onOpenFile,
  onSessionAction,
}: {
  projectId: string;
  profileId?: string;
  tabs: readonly WorkspaceTab[];
  onOpenUrl: (url: string, mode?: OpenMode) => void;
  granted?: string[];
  surface: SidebarSurface;
  builder: boolean;
  onOpenSession: (session: AgentSession, mode?: OpenMode) => void;
  onOpenTab: (tab: WorkspaceTab, mode?: OpenMode) => void;
  onOpenFile: (path: string, mode?: OpenMode) => void;
  onSessionAction: (
    id: string,
    action: "archive" | "mark-read" | "mark-unread",
  ) => void;
}): AppCollections {
  const { apiClient } = useCatamorphic();
  const queryClient = useQueryClient();
  const actions = useRef({
    onOpenSession,
    onOpenTab,
    onOpenFile,
    onSessionAction,
    onOpenUrl,
    tabs,
  });
  actions.current = {
    onOpenSession,
    onOpenTab,
    onOpenFile,
    onSessionAction,
    onOpenUrl,
    tabs,
  };
  const tabListeners = useRef(new Set<() => void>());
  const previousTabs = useRef(tabs);
  useEffect(() => {
    if (previousTabs.current === tabs) return;
    previousTabs.current = tabs;
    for (const listener of tabListeners.current) listener();
  }, [tabs]);
  const grantedKey = JSON.stringify(granted ?? []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: grantedKey is the value identity of the complete grant list.
  return useMemo(() => {
    const allowed = new Set(granted ?? []);
    const sessions = new Map<string, AgentSession>();
    const openers = new Map<string, (mode?: OpenMode) => void>();
    const admitted = new Map<string, Map<string, AppCollectionItem>>();
    const loadedParents = new Map<string, Set<string | null>>();
    const requireSource = (source: string) => {
      if (!allowed.has(source) || (!builder && ["git", "prs"].includes(source)))
        throw new Error(`Source ${source} is not granted to this widget`);
    };
    const result: AppCollections = {
      read: async ({ source, parentId, cursor, signal }) => {
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
          const response = await apiClient.GET(
            "/api/projects/{projectId}/agent/sessions",
            {
              params: {
                path: { projectId },
                query: {
                  limit: 50,
                  offset,
                  ...(source === "chats"
                    ? { visibility: "promoted" as const }
                    : {}),
                  ...(parent
                    ? { parentSessionId: parent }
                    : source === "activity"
                      ? {}
                      : { rootsOnly: "true" }),
                },
              },
              signal,
            },
          );
          if (!response.data)
            throw new Error(response.error?.error ?? "Could not load sessions");
          items = response.data.items
            .filter(
              (session) =>
                session.visibility !== "archived" &&
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
                badges: session.attentionRequired
                  ? ["Needs you"]
                  : session.running
                    ? ["Working"]
                    : [],
                actions: [
                  { id: "open", label: "Open chat" },
                  { id: "archive", label: "Archive", icon: "Archive" },
                  { id: "mark-read", label: "Mark as read" },
                  { id: "mark-unread", label: "Mark as unread" },
                ],
                data: {
                  status: session.status,
                  agentId: session.agentId,
                  source: session.source,
                },
              };
            });
          if (offset + response.data.items.length < response.data.total)
            next = String(offset + response.data.items.length);
        } else if (source === "files") {
          const files = await queryClient.fetchQuery({
            queryKey: ["desktop", "local-files", projectId],
            queryFn: () => desktopApi.projectLocalFiles(projectId),
            staleTime: 1000,
          });
          const tree = buildTree(
            files
              .map((file) => file.path)
              .filter((path) => isVisibleProjectFile(path, !builder)),
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
                });
              if (node.children) visit(node.children, node.path);
            }
          };
          visit(tree, null);
          items = all.slice(offset, offset + 100);
          if (offset + 100 < all.length) next = String(offset + 100);
        } else if (source === "workflows") {
          const response = await apiClient.GET(
            "/api/projects/{projectId}/workflows",
            { params: { path: { projectId } }, signal },
          );
          if (!response.data) throw new Error("Could not read workflows");
          items = response.data.map((workflow) => ({
            id: workflow.name,
            label: workflow.displayName ?? workflow.name,
            icon: "Workflow",
            actions: [{ id: "open", label: "Open workflow" }],
          }));
        } else if (source === "apps") {
          const response = await apiClient.GET(
            "/api/projects/{projectId}/apps",
            { params: { path: { projectId } }, signal },
          );
          if (!response.data) throw new Error("Could not read apps");
          items = response.data.map((app) => ({
            id: app.name,
            label: app.title,
            icon: app.icon,
            actions: [{ id: "open", label: "Open app" }],
          }));
        } else if (source === "prs") {
          const prs = await desktopApi.prList(projectId);
          items = prs.map((pr) => ({
            id: String(pr.number),
            label: pr.title,
            description: pr.author,
            icon: "GitPullRequest",
            actions: [{ id: "open", label: "Open review" }],
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
          const data = await desktopApi.bookmarksGet({ projectId, profileId });
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
                data: { url: bookmark.url },
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
          items = actions.current.tabs.map((tab) => {
            const id = `${tab.kind}:${tab.name}`;
            openers.set(`tabs:${id}`, (mode) =>
              actions.current.onOpenTab(tab, mode),
            );
            return {
              id,
              label: tab.label ?? tab.name,
              icon: "PanelTop",
              parentId: tab.groupId ?? null,
              actions: [{ id: "open", label: "Focus tab" }],
            };
          });
        } else throw new Error(`Source ${source} has no collection adapter`);
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
        const parents = loadedParents.get(source) ?? new Set<string | null>();
        parents.add(parentId ?? null);
        loadedParents.set(source, parents);
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
              if (change.projectId === projectId) refresh();
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
                  change.profileId === profileId &&
                  (!change.projectId || change.projectId === projectId)
                )
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
    grantedKey,
    surface.sessionId,
    builder,
  ]);
}
