import { useProjects, useWorkflows } from "@catamorphic/react";
import type { AgentSession } from "@catamorphic/react/types";
import {
  ChevronRight,
  FolderPlus,
  PanelLeft,
  Plus,
  Settings as SettingsIcon,
  Workflow as WorkflowIcon,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { AgentChat } from "./components/catamorphic/agent-chat.js";
import { ProjectsList } from "./components/catamorphic/projects-list.js";
import { SessionsList } from "./components/catamorphic/sessions-list.js";
import { SettingsScreen } from "./screens/settings-screen.js";
import { WorkflowScreen } from "./screens/workflow-screen.js";

type MainView =
  | { kind: "chat" }
  | { kind: "settings" }
  | { kind: "workflow"; workflowName: string };

export function App({ hasCodingAgent }: { hasCodingAgent: boolean }) {
  const projectsQuery = useProjects();
  const [activeProjectId, setActiveProjectId] = useState<string>();
  const [activeSessionId, setActiveSessionId] = useState<string>();
  const [view, setView] = useState<MainView>({ kind: "chat" });
  const [creatingProject, setCreatingProject] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  const projects = projectsQuery.data?.items ?? [];
  const activeProject =
    projects.find((project) => project.id === activeProjectId) ?? projects[0];
  const projectId = activeProject?.id;

  const selectSession = (session: AgentSession | undefined) => {
    setActiveSessionId(session?.id);
    setView({ kind: "chat" });
  };

  const selectProject = (id: string) => {
    setActiveProjectId(id);
    setActiveSessionId(undefined);
    setCreatingProject(false);
    setView({ kind: "chat" });
  };

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
            <select
              value={projectId ?? ""}
              onChange={(event) => selectProject(event.target.value)}
              className="app-no-drag h-8 min-w-0 flex-1 cursor-pointer rounded-md border border-border bg-bg-inset px-2 text-[13px] font-medium text-fg"
              aria-label="Project"
              disabled={projects.length === 0}
            >
              {projects.length === 0 && <option value="">No projects</option>}
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => setCreatingProject((value) => !value)}
              className="app-no-drag grid size-8 shrink-0 cursor-pointer place-items-center rounded-md text-fg-muted transition-colors duration-150 hover:bg-bg-overlay hover:text-fg"
              aria-label="New project"
              title="New project"
            >
              <FolderPlus className="size-3.5" />
            </button>
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
                        view.kind === "workflow" ? view.workflowName : undefined
                      }
                      onSelect={(workflowName) =>
                        setView({ kind: "workflow", workflowName })
                      }
                    />
                  </SidebarSection>
                  <SidebarSection
                    title="Chats"
                    defaultOpen
                    action={
                      <button
                        type="button"
                        onClick={() => selectSession(undefined)}
                        className="grid size-6 cursor-pointer place-items-center rounded text-fg-muted transition-colors duration-150 hover:bg-bg-overlay hover:text-fg"
                        aria-label="New chat"
                        title="New chat"
                      >
                        <Plus className="size-3.5" />
                      </button>
                    }
                  >
                    <SessionsList
                      projectId={projectId}
                      activeSessionId={
                        view.kind === "chat" ? activeSessionId : undefined
                      }
                      onSelect={(session) => selectSession(session)}
                    />
                  </SidebarSection>
                </>
              )
            )}
          </div>

          <footer className="border-t border-border p-2">
            <button
              type="button"
              onClick={() =>
                setView((current) =>
                  current.kind === "settings"
                    ? { kind: "chat" }
                    : { kind: "settings" },
                )
              }
              className={`flex h-7 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-[13px] transition-colors duration-150 ${
                view.kind === "settings"
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

      <main className="flex min-w-0 flex-1 flex-col">
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
        {view.kind === "settings" ? (
          <SettingsScreen onClose={() => setView({ kind: "chat" })} />
        ) : view.kind === "workflow" && projectId ? (
          <WorkflowScreen
            projectId={projectId}
            workflowName={view.workflowName}
          />
        ) : projectId ? (
          <div className="flex min-h-0 flex-1 flex-col px-6 pb-4">
            {!hasCodingAgent && <MissingKeyNotice />}
            <AgentChat
              projectId={projectId}
              sessionId={activeSessionId}
              onSessionCreated={setActiveSessionId}
              variant="full"
              className="mx-auto min-h-0 flex-1"
              title={activeProject?.name ?? "AI assistant"}
              placeholder="Describe what you want to build…"
            />
          </div>
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
  onSelect: (workflowName: string) => void;
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
            onClick={() => onSelect(workflow.name)}
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

function MissingKeyNotice() {
  return (
    <div className="mx-auto mb-3 w-full max-w-3xl rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
      No model API key configured — the assistant is disabled. Add one in
      Settings.
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
