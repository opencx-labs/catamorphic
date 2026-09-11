import { CollectionTree, useItemActions } from "@catamorphic/app/ui";
import { useWorkflows } from "@catamorphic/react";
import type { AgentSession } from "@catamorphic/react/types";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronRight,
  GitBranch,
  PanelRight,
  Plus,
  Search,
} from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { chatBookmarkUrl } from "../../shared/bookmark-target.js";
import type { OpenMode as CommitMode } from "../../shared/open-mode.js";
import {
  matchesProjectExperience,
  type ProjectExperienceContext,
} from "../../shared/project-experience.js";
import {
  matchesSidebarSurface,
  resolveSidebarSection,
  type SidebarSurface,
} from "../../shared/sidebar.js";
import {
  type ChatSessionAction,
  chatSessionMenu,
} from "../lib/chat-session-actions.js";
import {
  type AgentsData,
  desktopApi,
  type SidebarItem,
  type SidebarMenuEntry,
  type SidebarSectionConfig,
} from "../lib/desktop-api.js";
import { sessionLabel } from "../lib/session-label.js";
import { useSidebarAppCollections } from "../lib/sidebar-app-collections.js";
import { useSidebarSessions } from "../lib/sidebar-sessions.js";
import { TAB_DRAG_TYPE, type TabDragPayload } from "../lib/tab-drag.js";
import { AppScreen, useApps } from "../screens/app-screen.js";
import { AnimatedTitle } from "./animated-title.js";
import { AppGlyph } from "./app-icon.js";
import { BookmarksNav } from "./bookmarks-nav.js";
import { ChatGlyph } from "./chat-icon.js";
import { SignalBadge } from "./chat-signals.js";
import { Collapsible } from "./collapsible.js";
import type { PaletteItem, PaletteSearchRequest } from "./command-palette.js";
import { FilesNav } from "./files-nav.js";
import { GitNav } from "./git-nav.js";
import { PrsNav } from "./prs-nav.js";
import { type RemoteFeatures, RemoteNav } from "./remote-nav.js";
import { ShortcutHint } from "./shortcut-hint.js";
import {
  projectSidebarItems,
  type SidebarContentState,
  SidebarContribution,
  sidebarItemPresentation,
  useSidebarContent,
  useSidebarContribution,
  useSidebarItemCount,
  useSidebarRefresh,
} from "./sidebar-contribution.js";
import { SidebarIcon, SidebarItemRow } from "./sidebar-item-row.js";
import {
  type SessionCommand,
  SidebarSessionInspector,
} from "./sidebar-session-inspector.js";
import { SidebarTree } from "./sidebar-tree.js";
import { SidebarActivity, SidebarNote } from "./sidebar-widgets.js";
import { SiteFavicon } from "./site-favicon.js";
import type { WorkspaceTab } from "./workspace-tabs.js";

// Heavy workspace surfaces stay out of the startup parse path. They remain
// mounted after first use so editor state and terminal sessions survive tab
// switches, but a session that never opens them never initializes their
// workers/WASM runtimes.

/** Offered to config-defined items that don't declare their own menu. */
const DEFAULT_CUSTOM_MENU: SidebarMenuEntry[] = [
  { label: "Open in new tab", action: "open-tab" },
  { label: "Copy link", action: "copy-url" },
];

/** One sidebar section, shaped by the user's sidebar.js config. */
export function ConfiguredSection({
  section: configured,
  relevant,
  surface,
  report,
  visible,
  onCustomize,
  onSearch,
  experienceContext,
  memberShell,
  projectId,
  profileId,
  pinnedStyle,
  tabs,
  sourceTabs,
  activeTab,
  activeChatSessionId,
  activeFilePath,
  keybindingLabel,
  agentsData,
  defaultAgentId,
  projectAgentNames,
  unreadSessionIds,
  onOpenTab,
  onNewChat,
  onNewWorkflow,
  onOpenSession,
  onSessionCommand,
  onSessionAction,
  onOpenUrl,
  onOpenFile,
  onOpenHistory,
  onPublish,
  onPropose,
}: {
  section: SidebarSectionConfig;
  relevant: boolean;
  surface: SidebarSurface;
  report: (state: SidebarContentState) => void;
  visible: boolean;
  onCustomize: () => void;
  onSearch: (
    request:
      | Omit<Extract<PaletteSearchRequest, { mode: "section" }>, "nonce">
      | { mode: "files" },
  ) => void;
  experienceContext: ProjectExperienceContext;
  memberShell: boolean;
  projectId: string;
  profileId?: string;
  pinnedStyle: "tiles" | "list";
  tabs: ReactNode;
  sourceTabs: WorkspaceTab[];
  activeTab?: WorkspaceTab;
  activeChatSessionId?: string;
  activeFilePath?: string;
  keybindingLabel: string;
  agentsData: AgentsData | null;
  defaultAgentId: string | null;
  projectAgentNames: Record<string, string>;
  unreadSessionIds: ReadonlySet<string>;
  onOpenTab: (tab: WorkspaceTab, mode?: CommitMode) => void;
  onNewChat: () => void;
  onNewWorkflow: () => void;
  onOpenSession: (session: AgentSession, mode?: CommitMode) => void;
  onSessionCommand: (session: AgentSession, command: SessionCommand) => void;
  onSessionAction: (sessionId: string, action: ChatSessionAction) => void;
  onOpenUrl: (url: string, mode: CommitMode) => void;
  onOpenFile: (filePath: string, mode?: CommitMode) => void;
  onOpenHistory: (filePath: string) => void;
  onPublish: (filePath: string, features: RemoteFeatures | undefined) => void;
  onPropose: (files: string[], features: RemoteFeatures | undefined) => void;
}) {
  const section = useMemo(
    () => resolveSidebarSection(configured),
    [configured],
  );
  const collections = useSidebarAppCollections({
    projectId,
    profileId,
    tabs: sourceTabs,
    onOpenUrl: (url, mode) => onOpenUrl(url, mode ?? "replace"),
    granted: section.collections,
    surface,
    builder: !memberShell,
    onOpenSession,
    onOpenTab,
    onOpenFile,
    onSessionAction,
  });
  const [contentState, setContentState] =
    useState<SidebarContentState>("loading");
  const [itemCounts, setItemCounts] = useState<ReadonlyMap<string, number>>(
    new Map(),
  );
  const reportItems = useCallback((id: string, count: number | null) => {
    setItemCounts((current) => {
      if (count === null ? !current.has(id) : current.get(id) === count)
        return current;
      const next = new Map(current);
      if (count === null) next.delete(id);
      else next.set(id, count);
      return next;
    });
  }, []);
  useEffect(() => {
    report(
      contentState === "ready" &&
        itemCounts.size &&
        ![...itemCounts.values()].some(Boolean)
        ? "empty"
        : contentState,
    );
  }, [report, contentState, itemCounts]);
  const refreshers = useRef(new Set<() => unknown>());
  const registerRefresh = useCallback((refresh: () => unknown) => {
    refreshers.current.add(refresh);
    return () => {
      refreshers.current.delete(refresh);
    };
  }, []);
  const commands = new Set([
    "new-chat",
    ...(!memberShell ? ["new-workflow"] : []),
    ...(["git", "prs", "files"].includes(section.type) ? ["search"] : []),
    ...([
      "chats",
      "subsessions",
      "files",
      "apps",
      "workflows",
      "git",
      "prs",
      "bookmarks",
      "remote",
      "note",
      "activity",
    ].includes(section.type)
      ? ["refresh"]
      : []),
  ]);
  const searchItems = useRef<() => Promise<PaletteItem[]>>(async () => []);
  const searchAction = (label: string, files = false) => (
    <ShortcutHint label={`Search ${label.toLowerCase()}`}>
      <button
        type="button"
        aria-label={`Search ${label.toLowerCase()}`}
        data-sidebar-search={
          files
            ? "search-files"
            : label === "Changes"
              ? "search-changes"
              : "search-prs"
        }
        className="grid size-7 shrink-0 place-items-center rounded-md text-fg-muted hover:bg-bg-overlay hover:text-fg"
        onClick={() =>
          onSearch(
            files
              ? { mode: "files" }
              : { mode: "section", label, load: () => searchItems.current() },
          )
        }
      >
        <Search className="size-3.5" />
      </button>
    </ShortcutHint>
  );
  const defaultOpen = !section.collapsed;
  const body = (() => {
    switch (section.type) {
      case "activity":
        return (
          <SidebarSection
            title={section.title ?? "Activity"}
            defaultOpen={defaultOpen}
          >
            {(expanded) => (
              <SidebarActivity
                projectId={projectId}
                visible={visible && expanded}
                onOpenSession={onOpenSession}
                onOpenTab={onOpenTab}
              />
            )}
          </SidebarSection>
        );
      case "note":
        return (
          <SidebarSection
            title={section.title ?? "Project note"}
            defaultOpen={defaultOpen}
          >
            {(expanded) => (
              <SidebarNote
                key={`${profileId}:${projectId}:${section.id}`}
                projectId={projectId}
                scope={`${profileId}:${projectId}:${section.id}`}
                path={section.path}
                visible={visible && expanded}
                onOpenFile={onOpenFile}
              />
            )}
          </SidebarSection>
        );
      case "app":
        return (
          <SidebarSection
            title={section.title ?? section.app ?? "App"}
            defaultOpen={defaultOpen}
            action={
              <ShortcutHint label="Open app in tab">
                <button
                  type="button"
                  aria-label="Open app in tab"
                  className="sidebar-tab"
                  onClick={() =>
                    section.app && onOpenTab({ kind: "app", name: section.app })
                  }
                >
                  <PanelRight className="size-3.5" />
                </button>
              </ShortcutHint>
            }
          >
            {(expanded) =>
              section.app ? (
                <AppScreen
                  projectId={projectId}
                  appName={section.app}
                  compact
                  surface={surface}
                  collections={collections}
                  onContentState={setContentState}
                  height={section.height}
                  visible={visible && expanded}
                />
              ) : (
                <button type="button" onClick={onCustomize}>
                  Choose an app
                </button>
              )
            }
          </SidebarSection>
        );
      case "workflows":
        return (
          <SidebarSection
            title={section.title ?? "Workflows"}
            defaultOpen={defaultOpen}
            action={
              !memberShell ? (
                <ShortcutHint label="Create workflow">
                  <button
                    type="button"
                    aria-label="Create workflow"
                    onClick={onNewWorkflow}
                    className="grid size-6 cursor-pointer place-items-center rounded text-fg-faint hover:bg-bg-overlay hover:text-fg"
                  >
                    <Plus className="size-3.5" />
                  </button>
                </ShortcutHint>
              ) : undefined
            }
          >
            <WorkflowsNav
              projectId={projectId}
              active={
                activeTab?.kind === "workflow" ? activeTab.name : undefined
              }
              onSelect={(workflow, mode) =>
                onOpenTab(
                  {
                    kind: "workflow",
                    name: workflow.name,
                    label: workflow.displayName ?? workflow.name,
                  },
                  mode,
                )
              }
            />
          </SidebarSection>
        );
      case "apps":
        return (
          <SidebarSection
            title={section.title ?? "Apps"}
            defaultOpen={defaultOpen}
          >
            <AppsNav
              projectId={projectId}
              active={activeTab?.kind === "app" ? activeTab.name : undefined}
              onSelect={(appName, mode) =>
                onOpenTab({ kind: "app", name: appName }, mode)
              }
            />
          </SidebarSection>
        );
      case "files":
        return (
          <SidebarSection
            title={section.title ?? "Files"}
            action={searchAction("Files", true)}
            defaultOpen={defaultOpen}
          >
            <FilesNav
              projectId={projectId}
              contentOnly={memberShell}
              activePath={activeFilePath}
              onOpen={onOpenFile}
            />
          </SidebarSection>
        );
      case "subsessions":
      case "chats":
        return (
          <SidebarSection
            title={
              section.title ??
              (section.type === "subsessions" ? "Subsessions" : "Chats")
            }
            defaultOpen={defaultOpen}
            action={
              <ShortcutHint label="New chat" shortcut={keybindingLabel}>
                <button
                  type="button"
                  onClick={onNewChat}
                  className="grid size-6 cursor-pointer place-items-center rounded text-fg-muted transition-colors duration-150 hover:bg-bg-overlay hover:text-fg"
                  aria-label="New chat"
                >
                  <Plus className="size-3.5" />
                </button>
              </ShortcutHint>
            }
          >
            <SessionsNav
              projectId={projectId}
              activeSessionId={surface.sessionId ?? activeChatSessionId}
              agentsData={agentsData}
              defaultAgentId={defaultAgentId}
              projectAgentNames={projectAgentNames}
              unreadSessionIds={unreadSessionIds}
              onCommand={onSessionCommand}
              onSelect={onOpenSession}
              onSessionAction={onSessionAction}
            />
          </SidebarSection>
        );
      case "tabs":
        return tabs ? (
          <SidebarSection
            title={section.title ?? "Tabs"}
            defaultOpen={defaultOpen}
          >
            {tabs}
          </SidebarSection>
        ) : null;
      case "bookmarks":
        if (!profileId) return null;
        return (
          <SidebarSection
            title={section.title ?? "Bookmarks"}
            defaultOpen={defaultOpen}
          >
            <BookmarksNav
              projectId={projectId}
              profileId={profileId}
              pinnedStyle={pinnedStyle}
              defaultOpenMode={section.open}
              menuOverride={section.menu}
              onOpen={(url, mode) =>
                onOpenUrl(url, mode ?? section.open ?? "replace")
              }
            />
          </SidebarSection>
        );
      case "git":
        return (
          <SidebarSection
            title={section.title ?? "Changes"}
            action={searchAction("Changes")}
            keepMounted
            defaultOpen={defaultOpen}
          >
            {(expanded) => (
              <GitNav
                searchItems={searchItems}
                key={projectId}
                visible={visible && expanded}
                activeSessionId={surface.sessionId ?? activeChatSessionId}
                projectId={projectId}
                onOpenDiff={onOpenTab}
              />
            )}
          </SidebarSection>
        );
      case "prs":
        return (
          <SidebarSection
            title={section.title ?? "Pull Requests"}
            action={searchAction("Pull requests")}
            defaultOpen={defaultOpen}
          >
            <PrsNav
              searchItems={searchItems}
              projectId={projectId}
              onOpenDiff={onOpenTab}
              onOpenUrl={onOpenUrl}
            />
          </SidebarSection>
        );
      case "remote":
        return (
          <SidebarSection
            title={section.title ?? "Server"}
            defaultOpen={defaultOpen}
          >
            <RemoteNav
              projectId={projectId}
              onOpenFile={onOpenFile}
              onOpenHistory={onOpenHistory}
              onPublish={onPublish}
              onPropose={onPropose}
            />
          </SidebarSection>
        );
      case "custom":
        return (
          <SidebarSection
            title={section.title ?? "Links"}
            defaultOpen={defaultOpen}
          >
            <CustomItems
              section={section}
              experienceContext={experienceContext}
              onOpenUrl={onOpenUrl}
            />
          </SidebarSection>
        );
      default:
        return null;
    }
  })();
  const hasBody = Boolean(body);
  useEffect(() => {
    if (!hasBody) setContentState("unavailable");
  }, [hasBody]);
  if (!body) return null;
  return (
    <SidebarContribution
      value={{
        section,
        surface,
        visible,
        relevant,
        report: setContentState,
        reportItems,
        open: onOpenUrl,
        commands,
        registerRefresh,
        command: async (action) => {
          if (!commands.has(action))
            throw new Error("This section does not support this action");
          if (action === "new-chat") onNewChat();
          else if (action === "new-workflow") onNewWorkflow();
          else if (action === "search")
            onSearch(
              section.type === "files"
                ? { mode: "files" }
                : {
                    mode: "section",
                    label: section.title ?? section.type,
                    load: () => searchItems.current(),
                  },
            );
          else if (action === "refresh")
            await Promise.all(
              [...refreshers.current].map((refresh) => refresh()),
            );
        },
      }}
    >
      {body}
    </SidebarContribution>
  );
}

/**
 * A user-defined section's items. Same row component as bookmarks, so a
 * config-authored item gets the identical ⋯ menu behavior; only the
 * bookmark-specific actions (pin/rename/remove) are inert here.
 */
function CustomItems({
  section,
  experienceContext,
  onOpenUrl,
}: {
  section: SidebarSectionConfig;
  experienceContext: ProjectExperienceContext;
  onOpenUrl: (url: string, mode: CommitMode) => void;
}) {
  const contribution = useSidebarContribution();
  const items = useMemo(() => {
    const result: (SidebarItem & {
      id: string;
      parentId: string | null;
      hasChildren: boolean;
    })[] = [];
    const visit = (entries: SidebarItem[], parentId: string | null) => {
      for (const item of entries) {
        if (
          !sidebarItemVisible(item, experienceContext) ||
          !matchesSidebarSurface(
            item.when,
            contribution?.surface ?? { kind: "none" },
          )
        )
          continue;
        const id =
          item.id ?? `${parentId ?? section.id}/${item.url ?? item.label}`;
        result.push({
          ...item,
          id,
          parentId,
          hasChildren: Boolean(item.items?.length),
        });
        visit(item.items ?? [], id);
      }
    };
    visit(section.items ?? [], null);
    return result;
  }, [section.items, section.id, experienceContext, contribution?.surface]);
  useSidebarContent(items.length ? "ready" : "empty");
  return (
    <SidebarTree
      items={items}
      label={section.title ?? "Custom items"}
      renderItem={(item, tree) => {
        const mode = item.open ?? section.open ?? "replace";
        return (
          <SidebarItemRow
            itemId={item.id}
            label={item.label}
            title={item.url}
            style={{ marginLeft: tree.depth * 14 }}
            icon={
              item.icon ??
              (item.url ? <SiteFavicon url={item.url} /> : "Folder")
            }
            description={item.description}
            badges={item.badges}
            progress={item.progress}
            supportedActions={item.url ? ["copy-url"] : []}
            menu={item.menu ?? (item.url ? DEFAULT_CUSTOM_MENU : [])}
            contextMenu={item.contextMenu}
            actions={item.actions}
            preview={item.preview}
            disclosure={
              tree.hasChildren
                ? { open: tree.expanded, onToggle: tree.toggle }
                : undefined
            }
            resource={Boolean(item.url)}
            defaultOpenMode={mode}
            onOpen={(intent) =>
              item.url ? onOpenUrl(item.url, intent) : tree.toggle()
            }
            onAction={(entry) => {
              if (entry.url) onOpenUrl(entry.url, mode);
              else if (entry.action === "copy-url" && item.url)
                void navigator.clipboard.writeText(item.url);
            }}
          />
        );
      }}
    />
  );
}

function sidebarItemVisible(
  item: SidebarItem,
  context: ProjectExperienceContext,
): boolean {
  if (item.hide || !matchesProjectExperience(item.when, context)) return false;
  if (item.url || item.actions?.length) return true;
  return (item.items ?? []).some((child) => sidebarItemVisible(child, context));
}

function SidebarSection({
  title,
  defaultOpen = false,
  keepMounted = false,
  action,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  keepMounted?: boolean;
  action?: ReactNode;
  children: ReactNode | ((expanded: boolean) => ReactNode);
}) {
  const contribution = useSidebarContribution();
  const headerActions = contribution?.section.headerActions;
  const actionState = useItemActions();
  const [open, setOpen] = useState(defaultOpen);
  const [visited, setVisited] = useState(defaultOpen);
  useEffect(() => {
    setOpen(defaultOpen);
    if (defaultOpen) setVisited(true);
  }, [defaultOpen]);
  const content =
    typeof children === "function"
      ? (keepMounted || visited || open) && children(open)
      : children;
  return (
    <section className="sidebar-section pb-2">
      <div className="flex items-center">
        <button
          type="button"
          onClick={() => {
            setVisited(true);
            setOpen((value) => !value);
          }}
          className="flex h-7 min-w-0 flex-1 cursor-pointer items-center justify-between gap-2 rounded-md px-2 text-xs font-medium text-fg-muted hover:text-fg"
          aria-expanded={open}
        >
          <span className="truncate">{title}</span>
          <ChevronRight
            className={`size-3 shrink-0 transition-transform duration-150 ease-[cubic-bezier(0.2,0,0,1)] ${
              open ? "rotate-90" : ""
            }`}
          />
        </button>
        {headerActions === undefined
          ? action
          : headerActions.map((entry) => (
              <ShortcutHint
                key={`${entry.action}:${entry.label}:${entry.url ?? ""}`}
                label={entry.disabledReason ?? entry.label}
              >
                <button
                  type="button"
                  aria-label={entry.label}
                  disabled={
                    Boolean(entry.disabledReason) ||
                    Boolean(actionState.pending) ||
                    (!entry.url && !contribution?.commands?.has(entry.action))
                  }
                  data-disabled-reason={
                    entry.disabledReason ??
                    (!entry.url && !contribution?.commands?.has(entry.action)
                      ? "This section does not support this action"
                      : undefined)
                  }
                  className="grid size-7 place-items-center rounded text-fg-muted hover:bg-bg-overlay"
                  onClick={() =>
                    void actionState.run({
                      id: entry.action,
                      label: entry.label,
                      disabledReason: entry.disabledReason,
                      run: () =>
                        entry.url
                          ? contribution?.open(entry.url, "replace")
                          : contribution?.command?.(entry.action),
                    })
                  }
                >
                  <SidebarIcon name={entry.icon} />
                </button>
              </ShortcutHint>
            ))}
      </div>
      {actionState.error && (
        <p role="alert" className="sidebar-empty-state">
          {actionState.error}
        </p>
      )}
      <Collapsible open={open}>
        {contribution ? (
          <SidebarContribution
            value={{ ...contribution, visible: contribution.visible && open }}
          >
            {content}
          </SidebarContribution>
        ) : (
          content
        )}
      </Collapsible>
    </section>
  );
}

function WorkflowsNav({
  projectId,
  active,
  onSelect,
}: {
  projectId: string;
  active?: string;
  onSelect: (
    workflow: { name: string; displayName?: string },
    mode?: CommitMode,
  ) => void;
}) {
  const query = useWorkflows(projectId);
  useSidebarRefresh(query.refetch);
  const items = (query.data ?? []).map((item) => ({ ...item, id: item.name }));
  useSidebarContent(
    query.isError
      ? "error"
      : query.isLoading
        ? "loading"
        : items.length
          ? "ready"
          : "empty",
  );
  if (query.isError)
    return (
      <p role="alert" className="sidebar-empty-state">
        Could not load workflows.{" "}
        <button type="button" onClick={() => void query.refetch()}>
          Retry
        </button>
      </p>
    );
  return (
    <SidebarTree
      items={items}
      label="Workflows"
      selectedId={active}
      renderItem={(item) => (
        <SidebarItemRow
          itemId={item.id}
          label={item.displayName ?? item.name}
          icon="Workflow"
          active={active === item.name}
          resource
          onOpen={(mode) =>
            onSelect(
              { name: item.name, displayName: item.displayName ?? undefined },
              mode,
            )
          }
          onAction={() => {}}
        />
      )}
    />
  );
}

function AppsNav({
  projectId,
  active,
  onSelect,
}: {
  projectId: string;
  active?: string;
  onSelect: (name: string, mode?: CommitMode) => void;
}) {
  const query = useApps(projectId);
  useSidebarRefresh(query.refetch);
  const items = (query.data ?? []).map((item) => ({ ...item, id: item.name }));
  useSidebarContent(
    query.isError
      ? "error"
      : query.isLoading
        ? "loading"
        : items.length
          ? "ready"
          : "empty",
  );
  if (query.isError)
    return (
      <p role="alert" className="sidebar-empty-state">
        Could not load apps.{" "}
        <button type="button" onClick={() => void query.refetch()}>
          Retry
        </button>
      </p>
    );
  return (
    <SidebarTree
      items={items}
      label="Apps"
      selectedId={active}
      renderItem={(item) => (
        <SidebarItemRow
          itemId={item.id}
          label={item.title}
          icon={<AppGlyph icon={item.icon} className="size-3.5" />}
          active={active === item.name}
          resource
          onOpen={(mode) => onSelect(item.name, mode)}
          onAction={() => {}}
        />
      )}
    />
  );
}

function SessionsNav({
  projectId,
  activeSessionId,
  agentsData,
  defaultAgentId,
  projectAgentNames,
  unreadSessionIds,
  onCommand,
  onSelect,
  onSessionAction,
}: {
  projectId: string;
  activeSessionId?: string;
  agentsData: AgentsData | null;
  defaultAgentId: string | null;
  projectAgentNames: Record<string, string>;
  unreadSessionIds: ReadonlySet<string>;
  onCommand: (session: AgentSession, command: SessionCommand) => void;
  onSelect: (session: AgentSession, mode?: CommitMode) => void;
  onSessionAction: (sessionId: string, action: ChatSessionAction) => void;
}) {
  const contribution = useSidebarContribution();
  const visible = contribution?.visible ?? true;
  const { collection, root } = useSidebarSessions({
    projectId,
    sessionId: contribution?.surface.sessionId,
    section: contribution?.section ?? { id: "chats", type: "chats" },
    visible,
    relevant: contribution?.relevant ?? true,
  });
  useSidebarRefresh(collection.load);
  const contentStatus = root.status;
  const contentIds = root.ids;
  const count = contentIds.filter(
    (id) =>
      !sidebarItemPresentation({ section: contribution?.section, id }).hide,
  ).length;
  useSidebarContent(
    contentStatus === "error"
      ? "error"
      : contentStatus === "idle" || contentStatus === "loading"
        ? "loading"
        : count
          ? "ready"
          : "empty",
  );
  useSidebarItemCount(count);
  const checkoutQuery = useQuery({
    queryKey: ["desktop", "session-checkouts", projectId],
    queryFn: () => desktopApi.sessionCheckouts(projectId),
    staleTime: 2000,
    enabled: contribution?.visible ?? true,
  });
  const client = useQueryClient();
  useEffect(
    () =>
      desktopApi.onGitChanged((event) => {
        if (event.projectId === projectId)
          void client.invalidateQueries({
            queryKey: ["desktop", "session-checkouts", projectId],
          });
      }),
    [client, projectId],
  );
  const checkoutBySession = new Map(
    (checkoutQuery.data ?? []).map((checkout) => [
      checkout.sessionId,
      checkout,
    ]),
  );
  return (
    <CollectionTree
      collection={collection}
      motionClasses={{
        enter: "animate-session-row-in",
        exit: "animate-session-row-out",
      }}
      groupBy={
        contribution?.section.source?.groupBy
          ? (session) =>
              String(
                Object.entries(session).find(
                  ([field]) => field === contribution.section.source?.groupBy,
                )?.[1] ?? "Other",
              )
          : undefined
      }
      project={(items) =>
        projectSidebarItems(items, contribution?.section).filter(
          (item) =>
            !sidebarItemPresentation({
              section: contribution?.section,
              id: item.id,
            }).hide,
        )
      }
      active={visible}
      selectedId={activeSessionId}
      rowHeight={contribution?.section.rowHeight}
      label={contribution?.section.title ?? "Chats"}
      height={contribution?.section.height}
      renderItem={(session, { depth, expanded, hasChildren, toggle }) => {
        const checkout = checkoutBySession.get(session.id);
        const agentId = session.agentId ?? defaultAgentId;
        const agentName =
          agentsData?.agents.find((agent) => agent.id === agentId)?.name ??
          (agentId ? projectAgentNames[agentId] : undefined) ??
          "Default";
        const checkoutLabel = checkout
          ? checkout.kind === "external"
            ? "External"
            : (checkout.branch ?? "Worktree")
          : undefined;
        return (
          // biome-ignore lint/a11y/noStaticElementInteractions: treeitem semantics and keyboard actions belong to the enclosing public Tree row.
          <div
            key={session.id}
            data-session-id={session.id}
            draggable
            onDragStart={(event) => {
              const url = chatBookmarkUrl({ projectId, sessionId: session.id });
              event.dataTransfer.setData(
                TAB_DRAG_TYPE,
                JSON.stringify({
                  key: `session:${session.id}`,
                  kind: "chat",
                  title: sessionLabel(session),
                  bookmarkUrl: url,
                } satisfies TabDragPayload),
              );
              event.dataTransfer.setData("text/uri-list", url);
              event.dataTransfer.effectAllowed = "copy";
            }}
          >
            <SidebarItemRow
              itemId={session.id}
              style={{ marginLeft: depth * 14 }}
              label={sessionLabel(session)}
              disclosure={
                hasChildren ? { open: expanded, onToggle: toggle } : undefined
              }
              icon={
                <ChatGlyph
                  icon={session.icon}
                  fork={Boolean(session.parentSessionId)}
                  className="size-3.5 shrink-0"
                />
              }
              active={session.id === activeSessionId}
              labelContent={
                <>
                  <AnimatedTitle text={sessionLabel(session)} />
                  {session.attentionRequired ? (
                    <span className="sr-only">Ready for you</span>
                  ) : unreadSessionIds.has(session.id) ? (
                    <span className="sr-only">Unread</span>
                  ) : null}
                </>
              }
              defaultMenu={chatSessionMenu({
                unread: unreadSessionIds.has(session.id),
                archived: false,
              })}
              preview={{
                title: sessionLabel(session),
                description: session.activity ?? undefined,
                metadata: [
                  { label: "Agent", value: agentName },
                  {
                    label: "Environment",
                    value: session.environment ?? "Default",
                  },
                  {
                    label: "Status",
                    value: session.running
                      ? "Working"
                      : session.status === "closed"
                        ? "Closed"
                        : "Ready",
                  },
                  ...(checkoutLabel
                    ? [{ label: "Checkout", value: checkoutLabel }]
                    : []),
                ],
              }}
              previewContent={
                <SidebarSessionInspector
                  projectId={projectId}
                  session={session}
                  agent={agentsData?.agents.find(
                    (agent) => agent.id === agentId,
                  )}
                  agentName={agentName}
                  checkout={checkout ?? null}
                  onCommand={(command) => onCommand(session, command)}
                  onArchive={() => onSessionAction(session.id, "archive")}
                />
              }
              end={
                <>
                  {(session.attentionRequired ||
                    unreadSessionIds.has(session.id)) && (
                    <span
                      data-testid={
                        session.attentionRequired
                          ? "session-attention"
                          : "session-unread"
                      }
                      className="grid size-3 shrink-0 place-items-center"
                      aria-hidden="true"
                    >
                      <SignalBadge
                        signals={{
                          attention: session.attentionRequired,
                          unread: unreadSessionIds.has(session.id),
                        }}
                        size="sm"
                      />
                    </span>
                  )}
                  {checkoutLabel ? (
                    <span className="ml-auto flex max-w-28 shrink-0 items-center gap-1 truncate rounded bg-bg-inset px-1.5 py-0.5 text-[10px] text-fg-faint">
                      <GitBranch className="size-2.5 shrink-0" />
                      <span className="truncate">{checkoutLabel}</span>
                    </span>
                  ) : null}
                </>
              }
              resource
              onOpen={(mode) => onSelect(session, mode)}
              onAction={(entry) => onSessionAction(session.id, entry.action)}
            />
          </div>
        );
      }}
    />
  );
}
