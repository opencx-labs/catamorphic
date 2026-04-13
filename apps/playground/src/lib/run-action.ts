"use server";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

interface RunStep {
  nodeId: string;
  name: string;
  status: "completed" | "failed" | "skipped";
  input?: unknown;
  output?: unknown;
  error?: string;
  startedAt: string;
  completedAt: string;
}

interface RunResult {
  runId: string | null;
  status: "completed" | "failed";
  result: unknown;
  error: string | null;
  steps: RunStep[];
  startedAt: string;
  completedAt: string;
}

export async function runWorkflowAction(opts: {
  projectId?: string;
  files: Record<string, string>;
  workflowName: string;
  triggerData?: Record<string, unknown>;
}): Promise<RunResult> {
  const response = await fetch(`${API_URL}/api/playground/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      projectId: opts.projectId,
      files: opts.files,
      workflowName: opts.workflowName,
      triggerData: opts.triggerData,
    }),
  });

  if (response.status === 503) {
    const body = (await response.json()) as { error: string };
    throw new Error(
      body.error ||
        "Sandbox provider not configured. Set DAYTONA_API_KEY to enable execution.",
    );
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Run failed: ${response.status} ${text}`);
  }

  return (await response.json()) as RunResult;
}
