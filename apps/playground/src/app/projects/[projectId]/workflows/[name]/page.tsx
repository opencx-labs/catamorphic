import type { PlaygroundRun } from "@catamorphic/ui";
import { notFound } from "next/navigation";
import { ApiError, api, type Run, type WorkflowGraph } from "@/lib/api";
import {
  displayNameFromWorkflowName,
  starterCodeForWorkflow,
  workflowFilePathFromName,
} from "@/lib/workflow-helpers";
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

/**
 * Synthetic graph used when the workflow name is not yet known to the server
 * (e.g. the user just created it in a draft that hasn't been deployed). The
 * client will re-parse from its localStorage drafts and render the real graph.
 */
function syntheticGraph(name: string): WorkflowGraph {
  const filePath = workflowFilePathFromName(name);
  const sourceCode = starterCodeForWorkflow(
    name,
    displayNameFromWorkflowName(name),
  );
  return {
    name,
    displayName: null,
    description: null,
    filePath,
    projectFiles: [],
    allFiles: {},
    trigger: { parameters: [] },
    nodes: [],
    edges: [],
    sourceCode,
  };
}

export default async function WorkflowPage({
  params,
}: {
  params: Promise<{ projectId: string; name: string }>;
}) {
  const { projectId, name } = await params;

  const [graphOrNull, projectOrNull] = await Promise.all([
    api.getWorkflow(projectId, name).catch((err) => {
      if (err instanceof ApiError && err.status === 404) return null;
      throw err;
    }),
    api.getProject(projectId).catch(() => null),
  ]);

  // Fetch baseline files so drafts can diff correctly. If this also fails we
  // bail out — something is broken beyond just "workflow not deployed yet".
  const baselineFiles =
    graphOrNull?.allFiles ??
    (await api.getFilesAtRef(projectId, "HEAD").catch(() => null));

  if (!projectOrNull && !graphOrNull && !baselineFiles) {
    notFound();
  }

  const graph = graphOrNull ?? syntheticGraph(name);
  const fallbackFiles = { [graph.filePath]: graph.sourceCode };
  const initialFiles = graphOrNull?.allFiles ?? baselineFiles ?? fallbackFiles;

  const runsResponse = await api.getRuns(projectId, name).catch(() => ({
    items: [],
    total: 0,
  }));
  const initialRuns = runsResponse.items.map(mapRun);

  return (
    <WorkflowPageClient
      projectId={projectId}
      projectName={projectOrNull?.name ?? null}
      workflowName={name}
      initialGraph={graph}
      initialFiles={initialFiles}
      initialRuns={initialRuns}
    />
  );
}
