export interface RunHandle {
  runId: string;
}

export interface RunStatus {
  runId: string;
  workflowId: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  triggerData?: unknown;
  result?: unknown;
  error?: string;
  startedAt: string;
  completedAt?: string;
  steps: StepStatus[];
}

export interface StepStatus {
  nodeId: string;
  name: string;
  status: "pending" | "running" | "completed" | "failed";
  input?: unknown;
  output?: unknown;
  error?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface RuntimeAdapter {
  startRun(input: {
    workflowId: string;
    code: string;
    triggerData: unknown;
  }): Promise<RunHandle>;
  getRun(input: { runId: string }): Promise<RunStatus>;
  listRuns(input: { workflowId: string }): Promise<RunStatus[]>;
  cancelRun(input: { runId: string }): Promise<void>;
}
