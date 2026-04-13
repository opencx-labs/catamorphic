import Link from "next/link";
import { SAMPLE_PROJECTS } from "@/lib/sample-projects";

const PROJECT_ICONS: Record<string, string> = {
  "welcome-user": "\u{1F44B}",
  "order-processing": "\u{1F4E6}",
  "data-pipeline": "\u{1F504}",
  "support-routing": "\u{1F3AB}",
};

export default function Home() {
  const projects = Object.entries(SAMPLE_PROJECTS);

  return (
    <main className="max-w-screen-2xl mx-auto px-6 py-12">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold">Projects</h1>
          <p className="text-neutral-400 mt-1">
            Create and manage workflow projects
          </p>
        </div>
        <Link
          href="/projects/new"
          className="px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded-lg text-sm font-medium transition-colors"
        >
          New Project
        </Link>
      </div>

      <div className="grid gap-4">
        {projects.map(([id, project]) => {
          const fileCount = Object.keys(project.files).filter(
            (f) => f.endsWith(".ts") || f.endsWith(".tsx"),
          ).length;

          return (
            <Link
              key={id}
              href={`/projects/${id}`}
              className="border border-neutral-800 rounded-lg p-6 hover:border-neutral-600 transition-colors group block"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <span className="text-2xl">
                    {PROJECT_ICONS[id] ?? "\u26A1"}
                  </span>
                  <div>
                    <h3 className="font-medium text-lg group-hover:text-blue-400 transition-colors">
                      {project.name}
                    </h3>
                    <p className="text-neutral-400 text-sm mt-1">
                      {project.description}
                    </p>
                    <div className="flex items-center gap-3 mt-2 text-xs text-neutral-500">
                      <span>
                        {fileCount} source file{fileCount !== 1 ? "s" : ""}
                      </span>
                    </div>
                  </div>
                </div>
                <span className="text-neutral-600 text-sm group-hover:text-neutral-400 transition-colors">
                  Open &rarr;
                </span>
              </div>
            </Link>
          );
        })}

        <Link
          href="/projects/new"
          className="border border-dashed border-neutral-800 rounded-lg p-8 flex items-center justify-center text-neutral-500 hover:border-neutral-600 hover:text-neutral-400 transition-colors"
        >
          <span className="text-sm">+ Create a new project</span>
        </Link>
      </div>
    </main>
  );
}
