import Link from "next/link";
import { api, type Project, type Template } from "@/lib/api";
import { createProjectFromTemplateAction } from "@/lib/project-actions";

const TEMPLATE_ICONS: Record<string, string> = {
  "welcome-user": "👋",
  "order-processing": "📦",
  "data-pipeline": "🔄",
  "support-routing": "🎫",
};

async function getPageData(): Promise<{
  templates: Template[];
  projects: Project[];
}> {
  try {
    const [templates, projectsResult] = await Promise.all([
      api.getTemplates(),
      api.getProjects(),
    ]);
    return { templates, projects: projectsResult.items };
  } catch {
    return { templates: [], projects: [] };
  }
}

export default async function Home() {
  const { templates, projects } = await getPageData();

  return (
    <main className="max-w-screen-2xl mx-auto px-6 py-12">
      {projects.length > 0 && (
        <section className="mb-12">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-xl font-semibold">Your Projects</h2>
          </div>
          <div className="grid gap-3">
            {projects.map((project) => (
              <Link
                key={project.id}
                href={`/projects/${project.id}`}
                className="cursor-pointer border border-neutral-800 rounded-lg p-5 hover:border-neutral-600 transition-colors group block"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="font-medium group-hover:text-blue-400 transition-colors">
                      {project.name}
                    </h3>
                    <p className="text-xs text-neutral-500 mt-1 font-mono">
                      {project.id.slice(0, 8)}&hellip;
                    </p>
                  </div>
                  <span className="text-neutral-600 text-sm group-hover:text-neutral-400 transition-colors">
                    Open &rarr;
                  </span>
                </div>
              </Link>
            ))}
          </div>
        </section>
      )}

      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">
            {projects.length === 0 ? "Start from a template" : "Templates"}
          </h1>
          <p className="text-neutral-400 mt-1 text-sm">
            Pick a template to create a new project with an initial git commit
          </p>
        </div>
        <Link
          href="/projects/new"
          className="cursor-pointer px-3 py-1.5 border border-neutral-700 hover:border-neutral-500 rounded text-sm transition-colors"
        >
          New project
        </Link>
      </div>

      <div className="grid sm:grid-cols-2 gap-4">
        {templates.map((template) => (
          <form
            key={template.id}
            action={createProjectFromTemplateAction.bind(
              null,
              template.id,
              template.name,
              template.defaultWorkflow,
            )}
          >
            <button
              type="submit"
              className="w-full cursor-pointer text-left border border-neutral-800 rounded-lg p-6 hover:border-neutral-600 transition-colors group block"
            >
              <div className="flex items-start gap-4">
                <span className="text-2xl shrink-0">
                  {TEMPLATE_ICONS[template.id] ?? "⚡"}
                </span>
                <div className="min-w-0">
                  <h3 className="font-medium group-hover:text-blue-400 transition-colors">
                    {template.name}
                  </h3>
                  <p className="text-neutral-400 text-sm mt-1">
                    {template.description}
                  </p>
                  <p className="text-neutral-600 text-xs mt-2">
                    {template.fileCount} source file
                    {template.fileCount !== 1 ? "s" : ""}
                  </p>
                </div>
              </div>
            </button>
          </form>
        ))}

        {templates.length === 0 && (
          <div className="col-span-2 text-center text-neutral-500 py-12 text-sm">
            Could not load templates. Make sure the server is running.
          </div>
        )}
      </div>
    </main>
  );
}
