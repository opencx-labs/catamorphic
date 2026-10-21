import { workflowKeys } from "@catamorphic/react";
import { PROJECT_STORE_DIR } from "@catamorphic/workflow/project-layout";
import type { SidebarSourceItem } from "../../shared/sidebar-source.js";
import { appIconName } from "../components/app-icon.js";
import { appsQuery } from "../lib/apps.js";
import { desktopApi } from "../lib/desktop-api.js";
import {
  buildTree,
  type FileTreeNode,
  isVisibleProjectFile,
} from "../lib/project-file-tree.js";
import { tabKey, type WorkspaceTab } from "../lib/workspace-types.js";
import {
  capabilitiesOf,
  childrenOf,
  invalidateBranches,
  pageOf,
  type SectionSource,
} from "./contract.js";
import type { WorkSourceDeps } from "./deps.js";

/** Program files changed: the project's lists are stale now. */
function onProgramChange(deps: WorkSourceDeps, refresh: () => void) {
  return desktopApi.onGitChanged((change) => {
    if (change.projectId !== deps.projectId) return;
    void deps.queryClient.invalidateQueries({
      queryKey: workflowKeys.project({ projectId: deps.projectId }),
    });
    void deps.queryClient.invalidateQueries({
      queryKey: ["cat", "project", deps.projectId, "apps"],
    });
    void deps.queryClient.invalidateQueries({
      queryKey: ["desktop", "local-files", deps.projectId],
    });
    refresh();
  });
}

/** `work:workflows`: the project's workflows; a row opens its graph. */
export function workflowsSource(deps: WorkSourceDeps): SectionSource {
  const source: SectionSource = {
    title: "Workflows",
    empty: "No workflows yet.",
    capabilities: () => capabilitiesOf(source),
    load: async ({ parentId }) => {
      if (parentId) return { items: [] };
      const workflows = await deps.queryClient.fetchQuery({
        queryKey: workflowKeys.list({
          projectId: deps.projectId,
          ref: undefined,
        }),
        staleTime: 1000,
        // The query's own signal: one reader leaving must not fail the
        // shared request another is waiting on.
        queryFn: async ({ signal }) => {
          const response = await deps.apiClient.GET(
            "/api/projects/{projectId}/workflows",
            {
              params: { path: { projectId: deps.projectId }, query: {} },
              signal,
            },
          );
          if (!response.data) throw new Error("Could not load workflows.");
          return response.data;
        },
      });
      return {
        items: workflows.map((workflow) => ({
          id: workflow.name,
          label: workflow.displayName ?? workflow.name,
          icon: "Workflow",
          url: `workflow:${workflow.name}`,
          data: { ...workflow },
        })),
      };
    },
    subscribe: (publish) =>
      onProgramChange(deps, () => publish({ type: "invalidate" })),
  };
  return source;
}

/** `work:apps`: the project's apps; a row opens the app. */
export function appsSource(deps: WorkSourceDeps): SectionSource {
  const source: SectionSource = {
    title: "Apps",
    empty: "No apps yet.",
    capabilities: () => capabilitiesOf(source),
    load: async ({ parentId }) => {
      if (parentId) return { items: [] };
      const apps = await deps.queryClient.fetchQuery({
        ...appsQuery({ apiClient: deps.apiClient, projectId: deps.projectId }),
        staleTime: 1000,
      });
      return {
        items: apps.map((app) => ({
          id: app.name,
          label: app.title,
          icon: appIconName(app.icon),
          url: `app:${app.name}`,
          data: { ...app },
        })),
      };
    },
    subscribe: (publish) =>
      onProgramChange(deps, () => publish({ type: "invalidate" })),
  };
  return source;
}

/**
 * `work:files`: the project folder as a tree, folders first. A member of a
 * connected project sees its content only (their own files and the store,
 * which starts open).
 */
export function filesSource(deps: WorkSourceDeps): SectionSource {
  const contentOnly = !deps.writesProgram;
  const rows = async (): Promise<SidebarSourceItem[]> => {
    const files = await deps.queryClient.fetchQuery({
      queryKey: ["desktop", "local-files", deps.projectId],
      queryFn: () => desktopApi.projectLocalFiles(deps.projectId),
      staleTime: 1000,
    });
    const all: SidebarSourceItem[] = [];
    const visit = (nodes: FileTreeNode[], parentId: string | null) => {
      for (const node of nodes) {
        all.push({
          id: node.path,
          parentId,
          hasChildren: Boolean(node.children),
          label: node.name,
          icon: node.children ? "Folder" : "File",
          ...(node.children
            ? contentOnly && PROJECT_STORE_DIR.startsWith(node.path)
              ? { collapsed: false }
              : {}
            : { url: `file:${node.path}` }),
          data: { path: node.path },
        });
        if (node.children) visit(node.children, node.path);
      }
    };
    visit(
      buildTree(
        files
          .map((file) => file.path)
          .filter((path) => isVisibleProjectFile(path, contentOnly)),
      ),
      null,
    );
    return all;
  };
  const source: SectionSource = {
    title: "Files",
    empty: "No files yet.",
    capabilities: () => capabilitiesOf(source),
    load: async ({ parentId, cursor }) =>
      pageOf(childrenOf(await rows(), parentId), cursor, 200),
    subscribe: (publish, { branches }) =>
      onProgramChange(deps, () => invalidateBranches(publish, branches())),
  };
  return source;
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
  extensions: "Puzzle",
  usage: "ChartColumn",
};

/**
 * `work:tabs`: the window's open tabs in strip order, chats among them. A
 * row brings its tab forward, closes from its row, says what a chat is
 * doing (`signal`, also in `data` for sorting), and drags to reorder the
 * strip; a tab dropped on a chat nests under it, and dropped among the top
 * tabs leaves its chat. A module that wraps it can sort and group tabs
 * however the person likes (working chats first); rows that change places
 * slide there.
 */
export function tabsSource(deps: WorkSourceDeps): SectionSource {
  const source: SectionSource = {
    title: "Tabs",
    empty: "No open tabs.",
    capabilities: () => capabilitiesOf(source),
    load: async ({ parentId }) => {
      const { tabs, activeTabKey, tabGroups } = deps.host();
      const parentOf = new Map(
        tabGroups.flatMap((group) =>
          group.memberKeys.map((key): [string, string] => [
            key,
            group.parentKey,
          ]),
        ),
      );
      // A group folded in the strip leaves its pages out of the window's
      // tabs: its chat has no children here then.
      const open = new Set(tabs.map(tabKey));
      const parents = new Set(
        tabGroups
          .filter((group) => group.memberKeys.some((key) => open.has(key)))
          .map((group) => group.parentKey),
      );
      return {
        items: tabs
          .filter((tab) => (parentOf.get(tabKey(tab)) ?? null) === parentId)
          .map((tab): SidebarSourceItem => {
            const id = tabKey(tab);
            const signal =
              tab.awaitingInput || tab.attention
                ? "attention"
                : tab.working
                  ? "working"
                  : tab.unread
                    ? "unread"
                    : undefined;
            const label = tab.label ?? tab.name;
            return {
              id,
              parentId,
              hasChildren: parents.has(id),
              // A chat's pages show under it, as in the strip; a tab dropped
              // on a chat nests there.
              ...(tab.kind === "chat"
                ? { acceptsChildren: true, collapsed: false }
                : {}),
              label,
              description: tab.detail,
              icon:
                tab.kind === "browser" && tab.faviconUrl
                  ? tab.faviconUrl
                  : tab.kind === "chat"
                    ? (tab.chatIcon ?? (tab.fork ? "GitFork" : "MessageSquare"))
                    : tab.kind === "app" && tab.appIcon
                      ? appIconName(tab.appIcon)
                      : (TAB_ICONS[tab.kind] ?? "PanelTop"),
              url: id,
              ...(signal ? { signal } : {}),
              // Close on hover, and in its menus beside the open modes.
              actions: [
                { label: `Close ${label}`, action: "close", icon: "X" },
              ],
              menu: [
                // A chat's tab is named as the chat is (ADR 0247).
                ...(tab.kind === "chat" && tab.sessionId
                  ? [{ label: "Rename…", action: "rename" }]
                  : []),
                { label: `Close ${label}`, action: "close" },
              ],
              data: {
                kind: tab.kind,
                name: tab.name,
                active: id === activeTabKey,
                working: Boolean(tab.working),
                attention: Boolean(tab.attention || tab.awaitingInput),
                unread: Boolean(tab.unread),
                ...(tab.groupId ? { groupId: tab.groupId } : {}),
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
          }),
      };
    },
    subscribe: (publish, { branches }) =>
      deps.onWindowChange("tabs", () =>
        invalidateBranches(publish, branches()),
      ),
    action: async ({ itemId, action }) => {
      const host = deps.host();
      const tab = host.tabs.find((candidate) => tabKey(candidate) === itemId);
      const sessionId = tab?.kind === "chat" ? tab.sessionId : undefined;
      if (action === "rename" && sessionId) {
        host.sessionAction(sessionId, "rename");
        return undefined;
      }
      if (action !== "close")
        throw new Error("This tab does not support that action");
      host.closeTab(itemId);
      return undefined;
    },
    move: async ({ itemId, parentId, beforeId }) => {
      // Among the tabs beside it, a tab only changes places; dropped on a
      // chat (or out of one) it joins that chat's group, as in the strip.
      const host = deps.host();
      const group = host.tabGroups.find((entry) =>
        entry.memberKeys.includes(itemId),
      );
      if ((group?.parentKey ?? null) === parentId)
        host.reorderTab(itemId, beforeId ?? null);
      else host.attachTab(itemId, parentId, beforeId ?? null);
    },
  };
  return source;
}
