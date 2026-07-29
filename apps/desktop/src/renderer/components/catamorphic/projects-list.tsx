"use client";

import {
  useCreateProject,
  useProjects,
  useTemplates,
} from "@catamorphic/react";
import type { ProjectSummary } from "@catamorphic/react/types";
import { useState } from "react";

export interface ProjectsListProps {
  /** Called when the user clicks a project row. Use it to navigate. */
  onOpen?: (project: ProjectSummary) => void;
}

/**
 * Table of projects available to the current tenant. Selecting a row calls
 * `onOpen` so the host can route to its own editor page; the create-project
 * dialog is rendered inline.
 */
export function ProjectsList({ onOpen }: ProjectsListProps) {
  const projectsQuery = useProjects();
  const [creating, setCreating] = useState(false);

  return (
    <div className="rounded-lg border border-border bg-bg-inset p-4">
      <header className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-fg">Projects</h2>
        <button
          type="button"
          onClick={() => setCreating((v) => !v)}
          className="h-9 cursor-pointer rounded border border-border-strong bg-bg-overlay px-3 text-sm font-medium text-fg hover:border-border-strong"
        >
          {creating ? "Cancel" : "New project"}
        </button>
      </header>

      {creating ? (
        <CreateProjectDialog
          onCreated={() => setCreating(false)}
          onCancel={() => setCreating(false)}
        />
      ) : null}

      {projectsQuery.isLoading ? (
        <p className="text-sm text-fg-muted">Loading projects…</p>
      ) : null}

      {projectsQuery.error ? (
        <p className="text-sm text-danger">
          Failed to load projects: {projectsQuery.error.message}
        </p>
      ) : null}

      {projectsQuery.data && projectsQuery.data.items.length === 0 ? (
        <p className="text-sm text-fg-muted">
          No projects yet. Click <em>New project</em> to create one.
        </p>
      ) : null}

      {projectsQuery.data && projectsQuery.data.items.length > 0 ? (
        <ul className="grid gap-2">
          {projectsQuery.data.items.map((project) => (
            <li key={project.id}>
              <button
                type="button"
                onClick={() => onOpen?.(project)}
                className="w-full text-left rounded border border-border bg-bg-overlay px-3 py-2 hover:border-border-strong"
              >
                <p className="text-sm font-medium text-fg">{project.name}</p>
                <p className="text-xs text-fg-muted font-mono">{project.id}</p>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function CreateProjectDialog({
  onCreated,
  onCancel,
}: {
  onCreated: (project: ProjectSummary) => void;
  onCancel: () => void;
}) {
  const templatesQuery = useTemplates();
  const createProject = useCreateProject();
  const [name, setName] = useState("");
  const [templateId, setTemplateId] = useState<string | undefined>(undefined);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    const project = await createProject.mutateAsync({
      name: name.trim(),
      templateId,
    });
    onCreated(project);
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="mb-4 grid gap-3 rounded border border-border bg-bg-overlay p-3"
    >
      <label className="grid gap-1 text-xs text-fg">
        <span>Name</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="my-project"
          className="h-8 rounded border border-border-strong bg-bg-inset px-2 text-sm text-fg focus:border-accent focus:outline-none"
        />
      </label>

      {templatesQuery.data && templatesQuery.data.length > 0 ? (
        <label className="grid gap-1 text-xs text-fg">
          <span>Template (optional)</span>
          <select
            value={templateId ?? ""}
            onChange={(e) => setTemplateId(e.target.value || undefined)}
            className="h-8 rounded border border-border-strong bg-bg-inset px-2 text-sm text-fg"
          >
            <option value="">— Empty project —</option>
            {templatesQuery.data.map((template) => (
              <option key={template.id} value={template.id}>
                {template.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {createProject.error ? (
        <p className="text-xs text-danger">{createProject.error.message}</p>
      ) : null}

      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="h-8 cursor-pointer rounded border border-border-strong px-3 text-xs text-fg-muted hover:border-border-strong"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={createProject.isPending || !name.trim()}
          className="h-8 cursor-pointer rounded bg-accent px-3 text-xs font-medium text-accent-fg hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {createProject.isPending ? "Creating…" : "Create"}
        </button>
      </div>
    </form>
  );
}
