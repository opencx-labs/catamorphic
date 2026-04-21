"use client";

import {
  buildUntitledWorkflowName,
  displayNameFromWorkflowName,
  starterCodeForWorkflow,
  useProject,
  useWriteProjectFile,
  workflowFilePathFromName,
} from "@catamorphic/react";
import Link from "next/link";
import { notFound, useRouter } from "next/navigation";
import { PluginsSettings } from "@/components/plugins-settings";

const WORKFLOW_ICON = "🎯";

export function ProjectDetailClient({ projectId }: { projectId: string }) {
  const router = useRouter();
  const projectQuery = useProject(projectId);
  const writeFile = useWriteProjectFile(projectId);

  if (projectQuery.isLoading) {
    return (
      <main className="max-w-screen-2xl mx-auto px-6 py-12 text-sm text-neutral-500">
        Loading project…
      </main>
    );
  }

  if (projectQuery.isError || !projectQuery.data) {
    notFound();
  }

  const project = projectQuery.data;

  const handleCreateWorkflow = async () => {
    const existing = new Set(project.workflows.map((wf) => wf.name));
    const workflowName = buildUntitledWorkflowName(existing);
    const displayName = displayNameFromWorkflowName(workflowName);
    const filePath = workflowFilePathFromName(workflowName);
    await writeFile.mutateAsync({
      path: filePath,
      content: starterCodeForWorkflow(workflowName, displayName),
      commitMessage: `Create workflow ${workflowName}`,
    });
    router.push(`/projects/${projectId}/workflows/${workflowName}`);
  };

  return (
    <main className="max-w-screen-2xl mx-auto px-6 py-12">
      <div className="flex items-center gap-2 text-sm text-neutral-400 mb-6">
        <Link
          href="/"
          className="cursor-pointer hover:text-neutral-200 transition-colors"
        >
          Projects
        </Link>
        <span className="text-neutral-600">/</span>
        <span className="text-neutral-200">{project.name}</span>
      </div>

      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold">{project.name}</h1>
          <p className="text-xs text-neutral-500 mt-1 font-mono">{projectId}</p>
        </div>
        <button
          type="button"
          onClick={handleCreateWorkflow}
          disabled={writeFile.isPending}
          className="h-9 cursor-pointer rounded border border-blue-600 bg-blue-600/20 px-3 text-sm font-medium text-blue-300 transition-colors hover:bg-blue-600/30 hover:text-blue-200 disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {writeFile.isPending ? "Creating…" : "New Workflow"}
        </button>
      </div>

      <section className="mb-10">
        <h2 className="text-lg font-semibold mb-4">Workflows</h2>
        {project.workflows.length === 0 ? (
          <div className="border border-dashed border-neutral-800 rounded-lg p-8 text-center text-neutral-500 text-sm">
            No workflows found. Use{" "}
            <span className="text-neutral-300">New Workflow</span> to create
            your first one.
          </div>
        ) : (
          <div className="grid gap-3">
            {project.workflows.map((wf) => (
              <Link
                key={wf.name}
                href={`/projects/${projectId}/workflows/${wf.name}`}
                className="cursor-pointer border border-neutral-800 rounded-lg p-5 hover:border-neutral-600 transition-colors group block"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span className="text-lg">{WORKFLOW_ICON}</span>
                    <div>
                      <h3 className="font-medium group-hover:text-blue-400 transition-colors">
                        {wf.displayName ?? wf.name}
                      </h3>
                      <div className="flex items-center gap-3 mt-1 text-xs text-neutral-500">
                        <span className="font-mono">{wf.name}()</span>
                        <span>&middot;</span>
                        <span>{wf.filePath}</span>
                        <span>&middot;</span>
                        <span>
                          {wf.parameterCount} param
                          {wf.parameterCount !== 1 ? "s" : ""}
                        </span>
                      </div>
                    </div>
                  </div>
                  <span className="text-neutral-600 text-sm group-hover:text-neutral-400 transition-colors">
                    Open &rarr;
                  </span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>

      <PluginsSettings projectId={projectId} />
    </main>
  );
}
