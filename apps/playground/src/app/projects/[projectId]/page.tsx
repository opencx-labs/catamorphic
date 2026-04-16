import Link from "next/link";
import { notFound } from "next/navigation";
import { api } from "@/lib/api";
import { createWorkflowInProjectAction } from "@/lib/project-actions";

const WORKFLOW_ICON = "🎯";

export default async function ProjectPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;

  let project: Awaited<ReturnType<typeof api.getProject>>;
  try {
    project = await api.getProject(projectId);
  } catch {
    notFound();
  }

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
        <form
          action={createWorkflowInProjectAction}
          className="flex items-center gap-2"
        >
          <input type="hidden" name="projectId" value={projectId} />
          <button
            type="submit"
            className="h-9 cursor-pointer rounded border border-blue-600 bg-blue-600/20 px-3 text-sm font-medium text-blue-300 transition-colors hover:bg-blue-600/30 hover:text-blue-200"
          >
            New Workflow
          </button>
        </form>
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
    </main>
  );
}
