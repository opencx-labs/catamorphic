"use client";

import Link from "next/link";
import { notFound, useParams } from "next/navigation";
import { useEffect, useState } from "react";
import {
  type DiscoverWorkflowsResult,
  discoverWorkflowsAction,
} from "@/lib/parse-action";
import { SAMPLE_PROJECTS } from "@/lib/sample-projects";

const WORKFLOW_TYPE_ICONS: Record<string, string> = {
  trigger: "\u{1F3AF}",
  step: "\u26A1",
};

export default function ProjectPage() {
  const params = useParams<{ projectId: string }>();
  const project = SAMPLE_PROJECTS[params.projectId];

  const [discovery, setDiscovery] = useState<DiscoverWorkflowsResult | null>(
    null,
  );

  useEffect(() => {
    if (!project) return;
    discoverWorkflowsAction({ files: project.files }).then(setDiscovery);
  }, [project]);

  if (!project) {
    notFound();
  }

  const tsFiles = Object.keys(project.files).filter(
    (f) => f.endsWith(".ts") || f.endsWith(".tsx"),
  );

  return (
    <main className="max-w-screen-2xl mx-auto px-6 py-12">
      <div className="flex items-center gap-2 text-sm text-neutral-400 mb-6">
        <Link href="/" className="hover:text-neutral-200 transition-colors">
          Projects
        </Link>
        <span className="text-neutral-600">/</span>
        <span className="text-neutral-200">{project.name}</span>
      </div>

      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold">{project.name}</h1>
          <p className="text-neutral-400 mt-1">{project.description}</p>
        </div>
      </div>

      <section className="mb-10">
        <h2 className="text-lg font-semibold mb-4">Workflows</h2>
        {!discovery ? (
          <div className="text-neutral-500 text-sm py-8 text-center">
            Discovering workflows...
          </div>
        ) : discovery.workflows.length === 0 ? (
          <div className="border border-dashed border-neutral-800 rounded-lg p-8 text-center text-neutral-500 text-sm">
            No workflows found. Add a function with{" "}
            <code className="text-neutral-300">&quot;use workflow&quot;</code>{" "}
            to get started.
          </div>
        ) : (
          <div className="grid gap-3">
            {discovery.workflows.map((wf) => (
              <Link
                key={wf.functionName}
                href={`/projects/${params.projectId}/workflows/${wf.functionName}`}
                className="border border-neutral-800 rounded-lg p-5 hover:border-neutral-600 transition-colors group block"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span className="text-lg">
                      {WORKFLOW_TYPE_ICONS.trigger}
                    </span>
                    <div>
                      <h3 className="font-medium group-hover:text-blue-400 transition-colors">
                        {wf.graph.displayName ?? wf.functionName}
                      </h3>
                      <div className="flex items-center gap-3 mt-1 text-xs text-neutral-500">
                        <span className="font-mono">{wf.functionName}()</span>
                        <span>&middot;</span>
                        <span>{wf.filePath}</span>
                        <span>&middot;</span>
                        <span>
                          {wf.graph.nodes.length} node
                          {wf.graph.nodes.length !== 1 ? "s" : ""}
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

      <section>
        <h2 className="text-lg font-semibold mb-4">Files</h2>
        <div className="border border-neutral-800 rounded-lg divide-y divide-neutral-800">
          {tsFiles.map((filePath) => (
            <div
              key={filePath}
              className="px-4 py-3 text-sm font-mono text-neutral-400"
            >
              {filePath}
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
