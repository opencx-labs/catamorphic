import { useAgentSessions, useWorkflows } from "@catamorphic/react";
import {
  Globe,
  LayoutGrid,
  MessageSquare,
  Workflow as WorkflowIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { historyIdentity } from "../../../shared/history.js";
import { webUsageKey } from "../../../shared/palette.js";
import type { SidebarItem } from "../../../shared/sidebar.js";
import { sidebarSections } from "../../../shared/workspace-config.js";
import { SiteFavicon } from "../../components/site-favicon.js";
import { type Bookmark, desktopApi } from "../../lib/desktop-api.js";
import { lucideIcon } from "../../lib/lucide-icon.js";
import { NEW_WORKFLOW_PROMPT } from "../../lib/workflow-authoring.js";
import { useApps } from "../../screens/app-screen.js";
import { usePaletteHost } from "../host.js";
import type { PaletteItem } from "../types.js";
import { bareUrl, hostOf } from "../urls.js";

/**
 * Project resources the palette opens: workflows, apps, chats, bookmarks
 * and custom sidebar links. Each ranks by its history counts (ADR 0186).
 */
export function useResourceRows() {
  const {
    projectId,
    profileId,
    workspaceConfig,
    onOpenUrl,
    onOpenTab,
    onOpenSession,
    onSendToAgent,
    canCreateWorkflows = false,
  } = usePaletteHost();
  const workflows = useWorkflows(projectId).data ?? [];
  const apps = useApps(projectId).data ?? [];
  const sessions =
    useAgentSessions(projectId, { limit: 100 }).data?.items ?? [];
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  useEffect(() => {
    if (!profileId || !projectId) return;
    let cancelled = false;
    void desktopApi.bookmarksGet({ projectId, profileId }).then((data) => {
      if (!cancelled) {
        setBookmarks([...data.pinned.bookmarks, ...data.project.bookmarks]);
      }
    });
    const unsubscribe = desktopApi.onBookmarksChanged((change) => {
      if (change.profileId !== profileId) return;
      // Profile-wide changes (projectId null, e.g. a browser import) have
      // no project scope attached — refetch the combined view.
      if (change.projectId === null) {
        void desktopApi.bookmarksGet({ projectId, profileId }).then((data) => {
          setBookmarks([...data.pinned.bookmarks, ...data.project.bookmarks]);
        });
        return;
      }
      if (change.projectId === projectId && change.project) {
        setBookmarks([...change.pinned.bookmarks, ...change.project.bookmarks]);
      }
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [projectId, profileId]);

  // Project resources rank by their history counts (ADR 0186).
  const projectUsage = useCallback(
    (kind: "workflow" | "app" | "chat", resource: string) =>
      projectId
        ? historyIdentity({ kind, projectId, resource })
        : `${kind}:${resource}`,
    [projectId],
  );
  const sidebarItems = useMemo<PaletteItem[]>(() => {
    const items: PaletteItem[] = [];
    if (canCreateWorkflows)
      items.push({
        id: "create-workflow",
        icon: WorkflowIcon,
        label: "Create workflow",
        detail: "Describe it to your agent",
        keywords: ["new", "workflow", "automation", "build"],
        kind: "action",
        category: "command",
        usage: "create-workflow",
        run: (mode) =>
          onSendToAgent(NEW_WORKFLOW_PROMPT, mode === "tab" ? "tab" : "float"),
      });
    for (const workflow of workflows) {
      const label = workflow.displayName ?? workflow.name;
      items.push({
        id: `workflow:${workflow.name}`,
        icon: WorkflowIcon,
        label,
        detail: "Workflow",
        keywords: [workflow.name, "workflow", "go to", "open"],
        kind: "navigate",
        category: "resource",
        usage: projectUsage("workflow", workflow.name),
        run: (mode) =>
          onOpenTab({ kind: "workflow", name: workflow.name, label }, mode),
      });
    }
    for (const app of apps) {
      items.push({
        id: `app:${app.name}`,
        icon: LayoutGrid,
        label: app.name,
        detail: "App",
        keywords: [app.name, "app", "go to", "open"],
        kind: "navigate",
        category: "resource",
        usage: projectUsage("app", app.name),
        run: (mode) => onOpenTab({ kind: "app", name: app.name }, mode),
      });
    }
    for (const session of sessions) {
      if (session.visibility === "latent") continue;
      const created = new Date(session.createdAt);
      const label =
        session.title ??
        `Chat ${created.toLocaleDateString()} ${created.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
      items.push({
        id: `session:${session.id}`,
        icon: MessageSquare,
        label,
        detail: session.visibility === "archived" ? "Archived chat" : "Chat",
        keywords: [
          label,
          "chat",
          "session",
          "conversation",
          ...(session.visibility === "archived" ? ["archived"] : []),
        ],
        kind: "navigate",
        category: "resource",
        usage: projectUsage("chat", session.id),
        run: (mode) => onOpenSession(session, mode),
      });
    }
    for (const bookmark of bookmarks) {
      items.push({
        id: `bookmark:${bookmark.id}`,
        icon: Globe,
        iconNode: (
          <SiteFavicon
            url={bookmark.url}
            faviconUrl={bookmark.faviconUrl}
            className="size-4"
          />
        ),
        label: bookmark.label,
        detail: hostOf(bookmark.url),
        keywords: [
          bookmark.label,
          hostOf(bookmark.url),
          bareUrl(bookmark.url),
          "bookmark",
        ],
        kind: "navigate",
        category: "bookmark",
        usage: webUsageKey(bookmark.url),
        bookmarked: true,
        run: (mode) => onOpenUrl(bookmark.url, mode),
      });
    }
    const addCustomItems = (customItems: SidebarItem[] | undefined) => {
      for (const item of customItems ?? []) {
        if (item.url) {
          const url = item.url;
          items.push({
            id: `custom:${item.label}:${url}`,
            icon: lucideIcon(item.icon) ?? Globe,
            iconNode: item.icon ? undefined : (
              <SiteFavicon url={url} className="size-4" />
            ),
            label: item.label,
            detail: hostOf(url),
            keywords: [item.label, hostOf(url), bareUrl(url), "link"],
            kind: "navigate",
            category: "bookmark",
            usage: webUsageKey(url),
            run: (mode) => onOpenUrl(url, mode),
          });
        }
        addCustomItems(item.items);
      }
    };
    for (const section of sidebarSections(workspaceConfig)) {
      if (section.type !== "custom") continue;
      addCustomItems(section.items);
    }
    return items;
  }, [
    canCreateWorkflows,
    onSendToAgent,
    projectUsage,
    workflows,
    apps,
    sessions,
    bookmarks,
    workspaceConfig,
    onOpenTab,
    onOpenSession,
    onOpenUrl,
  ]);

  return { projectUsage, resourceItems: sidebarItems, bookmarks };
}
