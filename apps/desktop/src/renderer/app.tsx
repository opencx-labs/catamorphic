import {
  useAgentSessions,
  useProjects,
  useWorkflows,
} from "@catamorphic/react";
import type { AgentSession } from "@catamorphic/react/types";
import {
  ChevronRight,
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
import { ProjectsList } from "./components/catamorphic/projects-list.js";
import { ChatBubbles } from "./components/chat-bubbles.js";
import { ChatDock, type ChatDockEntry } from "./components/chat-dock.js";
import { ProjectSwitcher } from "./components/project-switcher.js";
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

const newChatEntry = (mode: ChatDockEntry["mode"] = "full"): ChatDockEntry => ({
  localId: crypto.randomUUID(),
  mode,
  lastExpandedMode: mode === "min" ? "full" : mode,
});

const emptyWorkspace = (): Workspace => {
  const chat = newChatEntry("full");
  return { tabs: [], chats: [chat], activeChatId: chat.localId };
};

export function App({ hasCodingAgent }: { hasCodingAgent: boolean }) {
  const projectsQuery = useProjects();
  const [activeProjectId, setActiveProjectId] = useState<string>();
  const [workspaces, setWorkspaces] = useState<Record<string, Workspace>>({});
  const [showSettings, setShowSettings] = useState(false);
  const [creatingProject, setCreatingProject] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sendingByChat, setSendingByChat] = useState<Record<string, boolean>>(
    {},
  );
  const [unreadByChat, setUnreadByChat] = useState<Record<string, boolean>>({});

  const projects = projectsQuery.data?.items ?? [];
  const activeProject =
    projects.find((project) => project.id === activeProjectId) ?? projects[0];
  const projectId = activeProject?.id;

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
        // Opening a tab drops the chat out of fullscreen so the tab shows.
        chats: ws.chats.map((chat) =>
          chat.mode === "full"
            ? { ...chat, mode: "partial", lastExpandedMode: "partial" }
            : chat,
        ),
      };
    });

  const closeTab = (key: string) =>
    updateWorkspace((ws) => {
      const tabs = ws.tabs.filter((tab) => tabKey(tab) !== key);
      return {
        ...ws,
        tabs,
        activeTabKey:
          ws.activeTabKey === key
            ? tabs.length > 0
              ? tabKey(tabs[tabs.length - 1] as WorkspaceTab)
              : undefined
            : ws.activeTabKey,
      };
    });

  const toggleChat = (localId: string) =>
    updateWorkspace((ws) => ({
      ...ws,
      activeChatId: localId,
      chats: ws.chats.map((chat) => {
        if (chat.localId !== localId) {
          // Only one chat is expanded at a time.
          return chat.mode === "min" ? chat : { ...chat, mode: "min" };
        }
        const isExpandedActive =
          chat.mode !== "min" && ws.activeChatId === localId;
        return {
          ...chat,
          mode: isExpandedActive ? "min" : chat.lastExpandedMode,
        };
      }),
    }));

  const closeChat = (localId: string) =>
    updateWorkspace((ws) => {
      const chats = ws.chats.filter((chat) => chat.localId !== localId);
      return {
        ...ws,
        chats: chats.length > 0 ? chats : [newChatEntry("min")],
        activeChatId:
          ws.activeChatId === localId ? chats[0]?.localId : ws.activeChatId,
      };
    });

  const addChat = () =>
    updateWorkspace((ws) => {
      const entry = newChatEntry(ws.tabs.length > 0 ? "partial" : "full");
      return {
        ...ws,
        chats: [
          ...ws.chats.map((chat) =>
            chat.mode === "min" ? chat : { ...chat, mode: "min" as const },
          ),
          entry,
        ],
        activeChatId: entry.localId,
      };
    });

  const openSession = (session: AgentSession) =>
    updateWorkspace((ws) => {
      const existing = ws.chats.find((chat) => chat.sessionId === session.id);
      const entry = existing ?? {
        ...newChatEntry(ws.tabs.length > 0 ? "partial" : "full"),
        sessionId: session.id,
      };
      return {
        ...ws,
        chats: [
          ...ws.chats
            .filter((chat) => chat.localId !== entry.localId)
            .map((chat) =>
              chat.mode === "min" ? chat : { ...chat, mode: "min" as const },
            ),
          { ...entry, mode: entry.lastExpandedMode },
        ],
        activeChatId: entry.localId,
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

  const selectProject = (id: string) => {
    setActiveProjectId(id);
    setCreatingProject(false);
    setShowSettings(false);
  };

  const activeTab = workspace.tabs.find(
    (tab) => tabKey(tab) === workspace.activeTabKey,
  );

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
              onNewProject={() => setCreatingProject(true)}
            />
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-2">
            {creatingProject || projects.length === 0 ? (
              <ProjectsList onOpen={(project) => selectProject(project.id)} />
            ) : (
              projectId && (
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
              )
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
        <div className="app-drag flex h-10 shrink-0 items-center px-2">
          <button
            type="button"
            onClick={() => setSidebarOpen((value) => !value)}
            className={`app-no-drag grid size-7 cursor-pointer place-items-center rounded-md text-fg-muted transition-colors duration-150 hover:bg-bg-overlay hover:text-fg ${
              sidebarOpen ? "" : "ml-[70px]"
            }`}
            aria-label={sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
            aria-expanded={sidebarOpen}
            title={sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
          >
            <PanelLeft className="size-4" />
          </button>
        </div>

        {showSettings ? (
          <SettingsScreen onClose={() => setShowSettings(false)} />
        ) : projectId ? (
          <>
            <WorkspaceTabBar
              tabs={workspace.tabs}
              activeKey={workspace.activeTabKey}
              onSelect={(key) =>
                updateWorkspace((ws) => ({ ...ws, activeTabKey: key }))
              }
              onClose={closeTab}
            />
            <div className="relative flex min-h-0 flex-1 flex-col">
              {activeTab?.kind === "workflow" ? (
                <WorkflowScreen
                  projectId={projectId}
                  workflowName={activeTab.name}
                />
              ) : activeTab?.kind === "app" ? (
                <AppScreen projectId={projectId} appName={activeTab.name} />
              ) : (
                <TabEmptyState hasCodingAgent={hasCodingAgent} />
              )}

              {workspace.chats.map((entry) => (
                <ChatDock
                  key={entry.localId}
                  projectId={projectId}
                  entry={entry}
                  title={activeProject?.name ?? "AI assistant"}
                  onEntryChange={(next) =>
                    updateWorkspace((ws) => ({
                      ...ws,
                      activeChatId: next.localId,
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
                labels={Object.fromEntries(
                  workspace.chats.map((chat, index) => [
                    chat.localId,
                    chat.sessionId
                      ? `Chat ${index + 1}`
                      : `New chat ${index + 1}`,
                  ]),
                )}
                sending={sendingByChat}
                unread={unreadByChat}
                activeLocalId={workspace.activeChatId}
                onToggle={toggleChat}
                onClose={closeChat}
                onNewChat={addChat}
              />
            </div>
          </>
        ) : (
          <EmptyState loading={projectsQuery.isLoading} />
        )}
      </main>
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
            <span className="truncate">{sessionLabel(session)}</span>
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

function EmptyState({ loading }: { loading: boolean }) {
  return (
    <div className="grid flex-1 place-items-center">
      <div className="max-w-sm text-center">
        {loading ? (
          <p className="animate-pulse text-sm text-fg-muted">Loading…</p>
        ) : (
          <>
            <p className="text-sm text-fg-muted">
              Create a project to start chatting with the assistant.
            </p>
            <p className="mt-2 text-xs text-fg-faint">
              Use the folder button in the sidebar.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
