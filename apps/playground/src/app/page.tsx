import Link from "next/link";
import { SAMPLE_WORKFLOWS } from "@/lib/sample-workflows";

const WORKFLOW_ICONS: Record<string, string> = {
  "welcome-user": "👋",
  "order-processing": "📦",
  "data-pipeline": "🔄",
  "support-routing": "🎫",
};

export default function Home() {
  const workflows = Object.entries(SAMPLE_WORKFLOWS);

  return (
    <main className="max-w-screen-2xl mx-auto px-6 py-12">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold">Workflows</h1>
          <p className="text-neutral-400 mt-1">
            Create and manage code-first workflows
          </p>
        </div>
        <Link
          href="/workflows/new"
          className="px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded-lg text-sm font-medium transition-colors"
        >
          New Workflow
        </Link>
      </div>

      <div className="grid gap-4">
        {workflows.map(([id, workflow]) => (
          <Link
            key={id}
            href={`/workflows/${id}`}
            className="border border-neutral-800 rounded-lg p-6 hover:border-neutral-600 transition-colors group block"
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-4">
                <span className="text-2xl">{WORKFLOW_ICONS[id] ?? "⚡"}</span>
                <div>
                  <h3 className="font-medium text-lg group-hover:text-blue-400 transition-colors">
                    {workflow.name}
                  </h3>
                  <p className="text-neutral-400 text-sm mt-1">
                    {workflow.description}
                  </p>
                </div>
              </div>
              <span className="text-neutral-600 text-sm group-hover:text-neutral-400 transition-colors">
                Open →
              </span>
            </div>
          </Link>
        ))}

        <Link
          href="/workflows/new"
          className="border border-dashed border-neutral-800 rounded-lg p-8 flex items-center justify-center text-neutral-500 hover:border-neutral-600 hover:text-neutral-400 transition-colors"
        >
          <span className="text-sm">+ Create a new workflow</span>
        </Link>
      </div>
    </main>
  );
}
