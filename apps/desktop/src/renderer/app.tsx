import {
  useAgentSessions,
  useProjects,
  useWorkflows,
} from "@catamorphic/react";
import type { AgentSession, ProjectSummary } from "@catamorphic/react/types";
import {
  ChevronRight,
  FolderPlus,
  LayoutGrid,
  PanelLeft,
  Plus,
  Settings as SettingsIcon,
  Workflow as WorkflowIcon,
} from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { AnimatedTitle } from "./components/animated-title.js";
import { ChatBubbles } from "./components/chat-bubbles.js";
import { ChatDock, type ChatDockEntry } from "./components/chat-dock.js";
import { DeleteProjectModal } from "./components/delete-project-modal.js";
import { ProjectModal } from "./components/project-modal.js";
import { ProjectSwitcher } from "./components/project-switcher.js";
import { ShortcutHint } from "./components/shortcut-hint.js";
import {
  tabKey,
  type WorkspaceTab,
  WorkspaceTabBar,
} from "./components/workspace-tabs.js";
import { AppScreen, useApps } from "./screens/app-screen.js";
import { SettingsScreen } from "./screens/settings-screen.js";
import { WorkflowScreen } from "./screens/workflow-screen.js";

interface Workspace {
  tabs: WorkspaceTab[];
  activeTabKey?: string;
  chats: ChatDockEntry[];
  activeChatId?: string;
}

const newChatEntry = (mode: ChatDockEntry["mode"]): ChatDockEntry => ({
  localId: crypto.randomUUID(),
  mode,
});

const emptyWorkspace = (): Workspace => ({ tabs: [], chats: [] });

const chatTabKey = (localId: string) => `chat:${localId}`;

const truncateLabel = (value: string): string =>
  value.length <= 40 ? value : `${value.slice(0, 39)}…`;

export function App({ hasCodingAgent }: { hasCodingAgent: boolean }) {
  const projectsQuery = useProjects();
  const [activeProjectId, setActiveProjectId] = useState<string>();
  const [workspaces, setWorkspaces] = useState<Record<string, Workspace>>({});
  const [showSettings, setShowSettings] = useState(false);
  const [projectModalOpen, setProjectModalOpen] = useState(false);
  const [deletingProject, setDeletingProject] = useState<ProjectSummary | null>(
    null,
  );
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sendingByChat, setSendingByChat] = useState<Record<string, boolean>>(
    {},
  );
  const [unreadByChat, setUnreadByChat] = useState<Record<string, boolean>>({});
  const [bubblesCollapsed, setBubblesCollapsed] = useState(false);

  const projects = projectsQuery.data?.items ?? [];
  const activeProject =
    projects.find((project) => project.id === activeProjectId) ?? projects[0];
  const projectId = activeProject?.id;

  // Shared with SessionsNav via the query cache; titles feed tab labels.
  const sessionsQuery = useAgentSessions(projectId);
  const sessionsById = new Map(
    (sessionsQuery.data?.items ?? []).map((session) => [session.id, session]),
  );

  // Stable per-project default so pre-first-write renders and the first
  // state update agree on the initial chat's localId.
  const defaultWorkspacesRef = useRef(new Map<string, Workspace>());
  const defaultWorkspaceFor = useCallback((id: string): Workspace => {
    const cache = defaultWorkspacesRef.current;
    const cached = cache.get(id);
    if (cached) return cached;
    const created = emptyWorkspace();
    cache.set(id, created);
    return created;
  }, []);

  const workspace: Workspace = projectId
    ? (workspaces[projectId] ?? defaultWorkspaceFor(projectId))
    : emptyWorkspace();

  const updateWorkspace = useCallback(
    (updater: (workspace: Workspace) => Workspace) => {
      if (!projectId) return;
      setWorkspaces((current) => ({
        ...current,
        [projectId]: updater(
          current[projectId] ?? defaultWorkspaceFor(projectId),
        ),
      }));
    },
    [projectId, defaultWorkspaceFor],
  );

  const openTab = (tab: WorkspaceTab) =>
    updateWorkspace((ws) => {
      const key = tabKey(tab);
      const exists = ws.tabs.some((existing) => tabKey(existing) === key);
      return {
        ...ws,
        tabs: exists ? ws.tabs : [...ws.tabs, tab],
        activeTabKey: key,
      };
    });

  /** Tab bar entries: fixed tabs plus one derived tab per tab-mode chat. */
  const chatTabs = (ws: Workspace, chatLabels: Record<string, string>) =>
    ws.chats
      .filter((chat) => chat.mode === "tab")
      .map(
        (chat): WorkspaceTab => ({
          kind: "chat",
          name: chat.localId,
          label: chatLabels[chat.localId] ?? "Chat",
        }),
      );

  const selectTab = (key: string) =>
    updateWorkspace((ws) => ({
      ...ws,
      activeTabKey: key,
      ...(key.startsWith("chat:")
        ? { activeChatId: key.slice("chat:".length) }
        : {}),
    }));

  const closeTab = (key: string) =>
    updateWorkspace((ws) => {
      // Closing a chat tab closes the chat (the session stays in the
      // sidebar); it does NOT linger as a bubble.
      if (key.startsWith("chat:")) {
        const localId = key.slice("chat:".length);
        const chats = ws.chats.filter((chat) => chat.localId !== localId);
        return {
          ...ws,
          chats,
          activeChatId:
            ws.activeChatId === localId ? undefined : ws.activeChatId,
          activeTabKey:
            ws.activeTabKey === key
              ? nextActiveTabKey(ws, key, chats)
              : ws.activeTabKey,
        };
      }
      const tabs = ws.tabs.filter((tab) => tabKey(tab) !== key);
      return {
        ...ws,
        tabs,
        activeTabKey:
          ws.activeTabKey === key
            ? nextActiveTabKey({ ...ws, tabs }, key, ws.chats)
            : ws.activeTabKey,
      };
    });

  const nextActiveTabKey = (
    ws: Workspace,
    closedKey: string,
    chats: ChatDockEntry[],
  ): string | undefined => {
    const keys = [
      ...ws.tabs.map(tabKey),
      ...chats
        .filter((chat) => chat.mode === "tab")
        .map((chat) => chatTabKey(chat.localId)),
    ].filter((key) => key !== closedKey);
    return keys.at(-1);
  };

  const toggleChat = (localId: string) =>
    updateWorkspace((ws) => {
      const target = ws.chats.find((chat) => chat.localId === localId);
      if (!target) return ws;
      const isExpandedActive =
        target.mode !== "min" && ws.activeChatId === localId;
      // Bubbles reopen as the floating dock, never as a full tab — going
      // to a tab is always an explicit gesture (the expand button).
      const nextMode = isExpandedActive
        ? ("min" as const)
        : ("partial" as const);
      return {
        ...ws,
        activeChatId: localId,
        activeTabKey:
          ws.activeTabKey === chatTabKey(localId)
            ? nextActiveTabKey(ws, chatTabKey(localId), ws.chats)
            : ws.activeTabKey,
        chats: ws.chats.map((chat) => {
          if (chat.localId !== localId) {
            // Floating docks are exclusive; background chat tabs stay put.
            return chat.mode === "partial" ? { ...chat, mode: "min" } : chat;
          }
          return { ...chat, mode: nextMode };
        }),
      };
    });

  const closeChat = (localId: string) =>
    updateWorkspace((ws) => {
      const chats = ws.chats.filter((chat) => chat.localId !== localId);
      return {
        ...ws,
        chats,
        activeChatId: ws.activeChatId === localId ? undefined : ws.activeChatId,
        activeTabKey:
          ws.activeTabKey === chatTabKey(localId)
            ? nextActiveTabKey(ws, chatTabKey(localId), chats)
            : ws.activeTabKey,
      };
    });

  const addChat = () =>
    updateWorkspace((ws) => {
      // New chats float as a partial dock by default; with no tabs open at
      // all, the chat becomes the workspace, so open it as a full tab.
      const noTabsOpen =
        ws.tabs.length === 0 && ws.chats.every((chat) => chat.mode !== "tab");
      const entry = newChatEntry(noTabsOpen ? "tab" : "partial");
      return {
        ...ws,
        chats: [
          ...ws.chats.map((chat) =>
            chat.mode === "partial" ? { ...chat, mode: "min" as const } : chat,
          ),
          entry,
        ],
        activeChatId: entry.localId,
        activeTabKey:
          entry.mode === "tab" ? chatTabKey(entry.localId) : ws.activeTabKey,
      };
    });

  const openSession = (session: AgentSession) =>
    updateWorkspace((ws) => {
      const existing = ws.chats.find((chat) => chat.sessionId === session.id);
      // Already-tabbed chats stay tabs; everything else opens as the
      // floating dock — unless no tabs are open, where a tab is the
      // natural landing (same rule as addChat).
      const noTabsOpen =
        ws.tabs.length === 0 && ws.chats.every((chat) => chat.mode !== "tab");
      const mode =
        existing?.mode === "tab" || noTabsOpen
          ? ("tab" as const)
          : ("partial" as const);
      const entry = existing ?? {
        ...newChatEntry(mode),
        sessionId: session.id,
      };
      return {
        ...ws,
        chats: [
          ...ws.chats
            .filter((chat) => chat.localId !== entry.localId)
            .map((chat) =>
              chat.mode === "partial"
                ? { ...chat, mode: "min" as const }
                : chat,
            ),
          { ...entry, mode },
        ],
        activeChatId: entry.localId,
        activeTabKey:
          mode === "tab" ? chatTabKey(entry.localId) : ws.activeTabKey,
      };
    });

  const onSessionCreated = useCallback(
    (localId: string, sessionId: string) =>
      updateWorkspace((ws) => ({
        ...ws,
        chats: ws.chats.map((chat) =>
          chat.localId === localId ? { ...chat, sessionId } : chat,
        ),
      })),
    [updateWorkspace],
  );

  // Latest chat modes for callbacks that outlive a render.
  const chatsRef = useRef(workspace.chats);
  chatsRef.current = workspace.chats;

  const sendingRef = useRef<Record<string, boolean>>({});
  const onSendingChange = useCallback((localId: string, sending: boolean) => {
    const wasSending = sendingRef.current[localId];
    if (wasSending === sending) return;
    sendingRef.current = { ...sendingRef.current, [localId]: sending };
    setSendingByChat(sendingRef.current);
    // Response landed while the chat was minimized → unread dot.
    const chat = chatsRef.current.find(
      (candidate) => candidate.localId === localId,
    );
    if (!sending && wasSending && chat?.mode === "min") {
      setUnreadByChat((unread) => ({ ...unread, [localId]: true }));
    }
  }, []);

  // Expanding a chat marks it read.
  useEffect(() => {
    const readIds = workspace.chats
      .filter((chat) => chat.mode !== "min")
      .map((chat) => chat.localId);
    if (readIds.some((id) => unreadByChat[id])) {
      setUnreadByChat((current) => {
        const next = { ...current };
        for (const id of readIds) delete next[id];
        return next;
      });
    }
  }, [workspace.chats, unreadByChat]);

  // Cmd+B toggles the sidebar, same as clicking the toggle button.
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (
        event.key === "b" &&
        event.metaKey &&
        !event.ctrlKey &&
        !event.altKey
      ) {
        event.preventDefault();
        setSidebarOpen((value) => !value);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const selectProject = (id: string) => {
    setActiveProjectId(id);
    setShowSettings(false);
  };

  const onProjectDeleted = (deletedId: string) => {
    setDeletingProject(null);
    setWorkspaces(({ [deletedId]: _removed, ...rest }) => rest);
    defaultWorkspacesRef.current.delete(deletedId);
    if (activeProjectId === deletedId) setActiveProjectId(undefined);
  };

  const activeTab = workspace.tabs.find(
    (tab) => tabKey(tab) === workspace.activeTabKey,
  );

  const chatLabels = Object.fromEntries(
    workspace.chats.map((chat, index) => {
      const session = sessionsById.get(chat.sessionId ?? "");
      return [
        chat.localId,
        session?.title
          ? truncateLabel(session.title)
          : chat.sessionId
            ? `Chat ${index + 1}`
            : "New chat",
      ];
    }),
  );
  const allTabs = [...workspace.tabs, ...chatTabs(workspace, chatLabels)];
  const activeChatTabId = workspace.activeTabKey?.startsWith("chat:")
    ? workspace.activeTabKey.slice("chat:".length)
    : undefined;

  return (
    <div className="flex h-full">
      <aside
        className={`flex shrink-0 flex-col overflow-hidden border-r border-border bg-bg-raised transition-[width] duration-200 ease-[cubic-bezier(0.2,0,0,1)] ${
          sidebarOpen ? "w-[260px]" : "w-0 border-r-0"
        }`}
        aria-hidden={!sidebarOpen}
        inert={!sidebarOpen ? true : undefined}
      >
        <div className="flex w-[260px] flex-1 flex-col overflow-hidden">
          <div className="app-drag h-10 shrink-0" />

          <div className="flex items-center gap-1 px-3 pb-3">
            <ProjectSwitcher
              projects={projects}
              activeProjectId={projectId}
              onSelect={selectProject}
              onNewProject={() => setProjectModalOpen(true)}
              onDeleteProject={setDeletingProject}
            />
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-2">
            {projectId && (
              <>
                <SidebarSection title="Workflows" defaultOpen>
                  <WorkflowsNav
                    projectId={projectId}
                    active={
                      activeTab?.kind === "workflow"
                        ? activeTab.name
                        : undefined
                    }
                    onSelect={(workflow) =>
                      openTab({
                        kind: "workflow",
                        name: workflow.name,
                        label: workflow.displayName ?? workflow.name,
                      })
                    }
                  />
                </SidebarSection>
                <SidebarSection title="Apps" defaultOpen>
                  <AppsNav
                    projectId={projectId}
                    active={
                      activeTab?.kind === "app" ? activeTab.name : undefined
                    }
                    onSelect={(appName) =>
                      openTab({ kind: "app", name: appName })
                    }
                  />
                </SidebarSection>
                <SidebarSection
                  title="Chats"
                  defaultOpen
                  action={
                    <button
                      type="button"
                      onClick={addChat}
                      className="grid size-6 cursor-pointer place-items-center rounded text-fg-muted transition-colors duration-150 hover:bg-bg-overlay hover:text-fg"
                      aria-label="New chat"
                      title="New chat"
                    >
                      <Plus className="size-3.5" />
                    </button>
                  }
                >
                  <SessionsNav
                    projectId={projectId}
                    activeSessionId={
                      workspace.chats.find(
                        (chat) => chat.localId === workspace.activeChatId,
                      )?.sessionId
                    }
                    onSelect={openSession}
                  />
                </SidebarSection>
              </>
            )}
          </div>

          <footer className="border-t border-border p-2">
            <button
              type="button"
              onClick={() => setShowSettings((value) => !value)}
              className={`flex h-7 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-[13px] transition-colors duration-150 ${
                showSettings
                  ? "bg-bg-overlay text-fg"
                  : "text-fg-muted hover:bg-bg-overlay hover:text-fg"
              }`}
            >
              <SettingsIcon className="size-3.5" />
              Settings
            </button>
          </footer>
        </div>
      </aside>

      <main className="relative flex min-w-0 flex-1 flex-col">
        {/* One chrome row: drag region + sidebar toggle + tabs. */}
        <div className="app-drag flex h-10 shrink-0 items-center gap-1 border-b border-border pl-2 pr-3">
          <span
            className={`app-no-drag transition-[margin] duration-200 ease-[cubic-bezier(0.2,0,0,1)] ${
              sidebarOpen ? "" : "ml-[70px]"
            }`}
          >
            <ShortcutHint label="Toggle sidebar" shortcut="⌘B">
              <button
                type="button"
                onClick={() => setSidebarOpen((value) => !value)}
                className="grid size-7 shrink-0 cursor-pointer place-items-center rounded-md text-fg-muted transition-colors duration-150 hover:bg-bg-overlay hover:text-fg"
                aria-label={sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
                aria-expanded={sidebarOpen}
              >
                <PanelLeft className="size-4" />
              </button>
            </ShortcutHint>
          </span>
          {!showSettings && projectId && (
            <WorkspaceTabBar
              tabs={allTabs}
              activeKey={workspace.activeTabKey}
              onSelect={selectTab}
              onClose={closeTab}
            />
          )}
        </div>

        {showSettings ? (
          <SettingsScreen onClose={() => setShowSettings(false)} />
        ) : projectId ? (
          <>
            <div className="relative flex min-h-0 flex-1 flex-col">
              {activeTab?.kind === "workflow" ? (
                <WorkflowScreen
                  projectId={projectId}
                  workflowName={activeTab.name}
                />
              ) : activeTab?.kind === "app" ? (
                <AppScreen projectId={projectId} appName={activeTab.name} />
              ) : activeChatTabId ? null : (
                <TabEmptyState hasCodingAgent={hasCodingAgent} />
              )}

              {workspace.chats.map((entry) => (
                <ChatDock
                  key={entry.localId}
                  projectId={projectId}
                  entry={entry}
                  title={chatLabels[entry.localId] ?? "AI assistant"}
                  tabActive={entry.localId === activeChatTabId}
                  bubbleClearance={bubblesCollapsed ? "corner" : "strip"}
                  onEntryChange={(next) =>
                    updateWorkspace((ws) => ({
                      ...ws,
                      activeChatId: next.localId,
                      activeTabKey:
                        next.mode === "tab"
                          ? chatTabKey(next.localId)
                          : ws.activeTabKey === chatTabKey(next.localId)
                            ? nextActiveTabKey(
                                ws,
                                chatTabKey(next.localId),
                                ws.chats.map((chat) =>
                                  chat.localId === next.localId ? next : chat,
                                ),
                              )
                            : ws.activeTabKey,
                      chats: ws.chats.map((chat) =>
                        chat.localId === next.localId ? next : chat,
                      ),
                    }))
                  }
                  onSessionCreated={onSessionCreated}
                  onSendingChange={onSendingChange}
                />
              ))}

              <ChatBubbles
                entries={workspace.chats}
                labels={chatLabels}
                sending={sendingByChat}
                unread={unreadByChat}
                activeLocalId={workspace.activeChatId}
                autoCollapse={activeChatTabId !== undefined}
                onCollapsedChange={setBubblesCollapsed}
                onToggle={toggleChat}
                onClose={closeChat}
                onNewChat={addChat}
              />
            </div>
          </>
        ) : (
          <EmptyState
            loading={projectsQuery.isLoading}
            onNewProject={() => setProjectModalOpen(true)}
          />
        )}
      </main>

      <ProjectModal
        open={projectModalOpen}
        onClose={() => setProjectModalOpen(false)}
        onCreated={(project) => {
          setProjectModalOpen(false);
          selectProject(project.id);
        }}
      />
      <DeleteProjectModal
        project={deletingProject}
        onClose={() => setDeletingProject(null)}
        onDeleted={onProjectDeleted}
      />
    </div>
  );
}

function SidebarSection({
  title,
  defaultOpen = false,
  action,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  action?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="pb-2">
      <div className="flex items-center">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="flex h-7 min-w-0 flex-1 cursor-pointer items-center gap-1 rounded-md px-2 text-[11px] font-semibold uppercase tracking-wider text-fg-faint transition-colors duration-150 hover:text-fg-muted"
          aria-expanded={open}
        >
          <ChevronRight
            className={`size-3 transition-transform duration-150 ease-[cubic-bezier(0.2,0,0,1)] ${
              open ? "rotate-90" : ""
            }`}
          />
          {title}
        </button>
        {action}
      </div>
      <div
        className={`grid transition-[grid-template-rows] duration-200 ease-[cubic-bezier(0.2,0,0,1)] ${
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        }`}
      >
        <div className="overflow-hidden">{children}</div>
      </div>
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
  onSelect: (workflow: { name: string; displayName?: string }) => void;
}) {
  const workflowsQuery = useWorkflows(projectId);
  const workflows = workflowsQuery.data ?? [];
  if (workflows.length === 0) {
    return (
      <p className="px-2 py-1 text-xs text-fg-faint">
        Ask the agent to create one.
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-0.5">
      {workflows.map((workflow) => (
        <li key={workflow.name}>
          <button
            type="button"
            onClick={() =>
              onSelect({
                name: workflow.name,
                displayName: workflow.displayName ?? undefined,
              })
            }
            className={`flex h-7 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-[13px] transition-colors duration-150 ${
              workflow.name === active
                ? "bg-bg-overlay text-fg"
                : "text-fg-muted hover:bg-bg-overlay/60 hover:text-fg"
            }`}
          >
            <WorkflowIcon className="size-3.5 shrink-0" />
            <span className="truncate">
              {workflow.displayName ?? workflow.name}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function AppsNav({
  projectId,
  active,
  onSelect,
}: {
  projectId: string;
  active?: string;
  onSelect: (appName: string) => void;
}) {
  const appsQuery = useApps(projectId);
  const apps = appsQuery.data ?? [];
  if (apps.length === 0) {
    return (
      <p className="px-2 py-1 text-xs text-fg-faint">
        Ask the agent to build one.
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-0.5">
      {apps.map((app) => (
        <li key={app.name}>
          <button
            type="button"
            onClick={() => onSelect(app.name)}
            className={`flex h-7 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-[13px] transition-colors duration-150 ${
              app.name === active
                ? "bg-bg-overlay text-fg"
                : "text-fg-muted hover:bg-bg-overlay/60 hover:text-fg"
            }`}
          >
            <LayoutGrid className="size-3.5 shrink-0" />
            <span className="truncate">{app.name}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function SessionsNav({
  projectId,
  activeSessionId,
  onSelect,
}: {
  projectId: string;
  activeSessionId?: string;
  onSelect: (session: AgentSession) => void;
}) {
  const sessionsQuery = useAgentSessions(projectId);
  const sessions = sessionsQuery.data?.items ?? [];
  if (sessions.length === 0) {
    return <p className="px-2 py-1 text-xs text-fg-faint">No chats yet.</p>;
  }
  return (
    <ul className="flex flex-col gap-0.5">
      {sessions.map((session) => (
        <li key={session.id}>
          <button
            type="button"
            onClick={() => onSelect(session)}
            className={`flex h-7 w-full cursor-pointer items-center gap-2 rounded px-2 text-left text-[13px] transition-colors duration-150 ${
              session.id === activeSessionId
                ? "bg-bg-overlay text-fg"
                : "text-fg-muted hover:bg-bg-overlay/60 hover:text-fg"
            }`}
            aria-current={session.id === activeSessionId || undefined}
          >
            <AnimatedTitle text={sessionLabel(session)} />
          </button>
        </li>
      ))}
    </ul>
  );
}

function sessionLabel(session: AgentSession): string {
  if (session.title) return session.title;
  const created = new Date(session.createdAt);
  return `Chat ${created.toLocaleDateString()} ${created.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

function TabEmptyState({ hasCodingAgent }: { hasCodingAgent: boolean }) {
  return (
    <div className="grid flex-1 place-items-center px-6">
      <div className="max-w-sm text-center">
        {!hasCodingAgent && (
          <div className="mb-3 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
            No model API key configured — the assistant is disabled. Add one in
            Settings.
          </div>
        )}
        <p className="text-sm text-fg-muted">
          Open a workflow or app from the sidebar, or talk to the assistant.
        </p>
      </div>
    </div>
  );
}

function EmptyState({
  loading,
  onNewProject,
}: {
  loading: boolean;
  onNewProject: () => void;
}) {
  return (
    <div className="grid flex-1 place-items-center">
      <div className="max-w-sm text-center">
        {loading ? (
          <p className="animate-pulse text-sm text-fg-muted">Loading…</p>
        ) : (
          <>
            <p className="text-sm text-fg-muted">
              Create a project from scratch or import an existing folder.
            </p>
            <button
              type="button"
              onClick={onNewProject}
              className="mt-4 inline-flex h-8 cursor-pointer items-center gap-2 rounded-md bg-accent px-3 text-[13px] font-medium text-accent-fg transition-opacity duration-150 hover:opacity-90"
            >
              <FolderPlus className="size-3.5" />
              New project
            </button>
          </>
        )}
      </div>
    </div>
  );
}
