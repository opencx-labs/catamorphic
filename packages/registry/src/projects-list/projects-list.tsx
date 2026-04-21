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
    <div className="rounded-lg border border-neutral-800 bg-neutral-950 p-4">
      <header className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-neutral-100">Projects</h2>
        <button
          type="button"
          onClick={() => setCreating((v) => !v)}
          className="h-9 cursor-pointer rounded border border-neutral-700 bg-neutral-900 px-3 text-sm font-medium text-neutral-200 hover:border-neutral-500"
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
        <p className="text-sm text-neutral-500">Loading projects…</p>
      ) : null}

      {projectsQuery.error ? (
        <p className="text-sm text-red-400">
          Failed to load projects: {projectsQuery.error.message}
        </p>
      ) : null}

      {projectsQuery.data && projectsQuery.data.items.length === 0 ? (
        <p className="text-sm text-neutral-500">
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
                className="w-full text-left rounded border border-neutral-800 bg-neutral-900 px-3 py-2 hover:border-neutral-600"
              >
                <p className="text-sm font-medium text-neutral-100">
                  {project.name}
                </p>
                <p className="text-xs text-neutral-500 font-mono">
                  {project.id}
                </p>
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
      className="mb-4 grid gap-3 rounded border border-neutral-800 bg-neutral-900 p-3"
    >
      <label className="grid gap-1 text-xs text-neutral-300">
        <span>Name</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="my-project"
          className="h-8 rounded border border-neutral-700 bg-neutral-950 px-2 text-sm text-neutral-100 focus:border-blue-600 focus:outline-none"
        />
      </label>

      {templatesQuery.data && templatesQuery.data.length > 0 ? (
        <label className="grid gap-1 text-xs text-neutral-300">
          <span>Template (optional)</span>
          <select
            value={templateId ?? ""}
            onChange={(e) => setTemplateId(e.target.value || undefined)}
            className="h-8 rounded border border-neutral-700 bg-neutral-950 px-2 text-sm text-neutral-100"
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
        <p className="text-xs text-red-400">{createProject.error.message}</p>
      ) : null}

      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="h-8 cursor-pointer rounded border border-neutral-700 px-3 text-xs text-neutral-400 hover:border-neutral-500"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={createProject.isPending || !name.trim()}
          className="h-8 cursor-pointer rounded bg-blue-600 px-3 text-xs font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {createProject.isPending ? "Creating…" : "Create"}
        </button>
      </div>
    </form>
  );
}
