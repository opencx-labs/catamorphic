export interface StepEntry {
  nodeId: string;
  name: string;
  status: "completed" | "failed" | "skipped";
  input?: unknown;
  output?: unknown;
  error?: string;
  startedAt: string;
  completedAt: string;
}

export interface RunReport {
  runId: string;
  status: "completed" | "failed";
  result?: unknown;
  error?: string;
  steps: StepEntry[];
  startedAt: string;
  completedAt: string;
}
