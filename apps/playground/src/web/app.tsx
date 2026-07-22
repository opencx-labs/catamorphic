import {
  useCreateProject,
  useProjects,
  useTemplates,
  useWorkflows,
} from "@catamorphic/react";
import { useState } from "react";
import { AgentChat } from "@/components/catamorphic/agent-chat.js";
import { WorkflowScreen } from "./workflow-screen.js";

export function App() {
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [selection, setSelection] = useState<{
    projectId: string;
    workflowName: string;
  } | null>(null);

  const selectProject = (projectId: string | null) => {
    setActiveProjectId(projectId);
    if (selection && selection.projectId !== projectId) setSelection(null);
  };

  return (
    <div className="pg-shell">
      <header className="pg-header">
        <h1>Catamorphic Playground</h1>
        <span className="pg-badge">Cloudflare Sandbox + Artifacts</span>
      </header>
      <div className="pg-main">
        <Sidebar
          activeProjectId={activeProjectId}
          onSelectProject={selectProject}
          selection={selection}
          onSelect={(projectId, workflowName) =>
            setSelection({ projectId, workflowName })
          }
        />
        <main className="pg-editor-pane">
          {selection ? (
            <WorkflowScreen
              key={`${selection.projectId}/${selection.workflowName}`}
              projectId={selection.projectId}
              workflowName={selection.workflowName}
            />
          ) : (
            <div className="pg-empty">
              {activeProjectId ? (
                <>
                  <p>Pick a workflow from the sidebar,</p>
                  <p>or ask the AI assistant to build one for you. →</p>
                </>
              ) : (
                <p>Create or select a project to get started.</p>
              )}
            </div>
          )}
        </main>
        {activeProjectId && (
          <div className="pg-agent-dock">
            <AgentChat key={activeProjectId} projectId={activeProjectId} />
          </div>
        )}
      </div>
    </div>
  );
}

function Sidebar({
  activeProjectId,
  onSelectProject,
  selection,
  onSelect,
}: {
  activeProjectId: string | null;
  onSelectProject: (projectId: string | null) => void;
  selection: { projectId: string; workflowName: string } | null;
  onSelect: (projectId: string, workflowName: string) => void;
}) {
  const projects = useProjects();

  return (
    <aside className="pg-sidebar">
      <CreateProjectForm onCreated={onSelectProject} />
      <div className="pg-sidebar-section">
        <h2>Projects</h2>
        {projects.isLoading && <p>Loading…</p>}
        {projects.error && <p className="pg-error">{projects.error.message}</p>}
        {projects.data?.items.map((project) => (
          <div key={project.id}>
            <button
              type="button"
              className={`pg-item ${activeProjectId === project.id ? "active" : ""}`}
              onClick={() =>
                onSelectProject(
                  activeProjectId === project.id ? null : project.id,
                )
              }
            >
              {project.name}
            </button>
            {activeProjectId === project.id && (
              <WorkflowList
                projectId={project.id}
                activeWorkflow={
                  selection?.projectId === project.id
                    ? selection.workflowName
                    : null
                }
                onSelect={onSelect}
              />
            )}
          </div>
        ))}
      </div>
    </aside>
  );
}

function WorkflowList({
  projectId,
  activeWorkflow,
  onSelect,
}: {
  projectId: string;
  activeWorkflow: string | null;
  onSelect: (projectId: string, workflowName: string) => void;
}) {
  const workflows = useWorkflows(projectId);
  if (workflows.isLoading) return <p style={{ paddingLeft: 12 }}>Loading…</p>;
  if (workflows.error)
    return <p className="pg-error">{workflows.error.message}</p>;
  const items = workflows.data ?? [];
  if (items.length === 0)
    return <p style={{ paddingLeft: 12, color: "#737373" }}>No workflows</p>;
  return (
    <div style={{ paddingLeft: 12 }}>
      {items.map((workflow) => (
        <button
          key={workflow.name}
          type="button"
          className={`pg-item ${activeWorkflow === workflow.name ? "active" : ""}`}
          onClick={() => onSelect(projectId, workflow.name)}
        >
          {workflow.name}
        </button>
      ))}
    </div>
  );
}

function CreateProjectForm({
  onCreated,
}: {
  onCreated: (projectId: string) => void;
}) {
  const create = useCreateProject();
  const templates = useTemplates();
  const [name, setName] = useState("");
  const [templateId, setTemplateId] = useState<string>("welcome-user");

  const submit = async () => {
    if (!name.trim()) return;
    const created = await create.mutateAsync({
      name: name.trim(),
      templateId: templateId || undefined,
    });
    setName("");
    onCreated(created.id);
  };

  return (
    <div className="pg-sidebar-section">
      <h2>New project</h2>
      <div className="pg-form" style={{ marginBottom: 6 }}>
        <input
          value={name}
          placeholder="Project name"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submit();
          }}
        />
      </div>
      <div className="pg-form">
        <select
          value={templateId}
          onChange={(e) => setTemplateId(e.target.value)}
          style={{
            flex: 1,
            minWidth: 0,
            padding: "6px 8px",
            border: "1px solid #333",
            borderRadius: 6,
            background: "#171717",
            color: "#fafafa",
            fontSize: 13,
          }}
        >
          <option value="">Blank</option>
          {templates.data?.map((template) => (
            <option key={template.id} value={template.id}>
              {template.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={create.isPending || !name.trim()}
        >
          Create
        </button>
      </div>
      {create.error && <p className="pg-error">{create.error.message}</p>}
    </div>
  );
}
