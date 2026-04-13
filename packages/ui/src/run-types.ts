export interface PlaygroundRunStep {
  nodeId: string;
  name: string;
  status: "completed" | "failed" | "skipped";
  input?: unknown;
  output?: unknown;
  error?: string;
  startedAt: string;
  completedAt: string;
}

export interface PlaygroundRun {
  id: string;
  workflowName: string;
  status: "pending" | "running" | "completed" | "failed";
  triggerData: Record<string, unknown>;
  result?: unknown;
  error?: string;
  steps: PlaygroundRunStep[];
  startedAt: string;
  completedAt?: string;
}
