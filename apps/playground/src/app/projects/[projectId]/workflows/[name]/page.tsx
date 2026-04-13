import type { PlaygroundRun } from "@catamorphic/ui";
import { notFound } from "next/navigation";
import { api, type Run, type WorkflowGraph } from "@/lib/api";
import { WorkflowPageClient } from "./workflow-page-client";

function mapRun(run: Run): PlaygroundRun {
  return {
    id: run.id,
    workflowName: run.workflowName,
    status:
      run.status === "cancelled"
        ? "failed"
        : (run.status as PlaygroundRun["status"]),
    triggerData:
      run.triggerData != null && typeof run.triggerData === "object"
        ? (run.triggerData as Record<string, unknown>)
        : {},
    result: run.result ?? undefined,
    error: run.error ?? undefined,
    steps: [],
    startedAt: run.startedAt ?? run.createdAt,
    completedAt: run.completedAt ?? undefined,
  };
}

export default async function WorkflowPage({
  params,
}: {
  params: Promise<{ projectId: string; name: string }>;
}) {
  const { projectId, name } = await params;

  let graph: WorkflowGraph;
  try {
    graph = await api.getWorkflow(projectId, name);
  } catch {
    notFound();
  }

  const runsResponse = await api.getRuns(projectId, name).catch(() => ({
    items: [],
    total: 0,
  }));
  const initialRuns = runsResponse.items.map(mapRun);

  return (
    <WorkflowPageClient
      projectId={projectId}
      workflowName={name}
      initialGraph={graph}
      initialFiles={graph.allFiles ?? { [graph.filePath]: graph.sourceCode }}
      initialRuns={initialRuns}
    />
  );
}
