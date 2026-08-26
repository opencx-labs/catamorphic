/** Where a provider's agent loop runs. */
export type AgentLoopPlacement = "control_plane" | "environment";

/** A cursor is exclusive: sequence 2 resumes with sequence 3. */
export interface AgentEventCursor {
  sequence: number;
}

export interface AgentRuntimeDescriptor {
  id: string;
  displayName: string;
  placement: AgentLoopPlacement;
  resumability: boolean;
  operations: AgentRuntimeOperationSupport;
  capabilities: AgentRuntimeCapabilities;
  models: readonly AgentRuntimeModel[];
  efforts: readonly AgentRuntimeEffort[];
  builtInTools: readonly AgentRuntimeTool[];
  mcpGenerations: readonly string[];
  eventFidelity: AgentRuntimeEventFidelity;
}

/** Command support that cannot be inferred from event fidelity. */
export interface AgentRuntimeOperationSupport {
  resumeSession: boolean;
  retryTurn: boolean;
  interruptTurn: boolean;
}

export interface AgentRuntimeCapabilities {
  approvals: boolean;
  questions: boolean;
  elicitations: boolean;
  plans: boolean;
  tasks: boolean;
  subagents: boolean;
  usage: boolean;
  dynamicTools: boolean;
}

export interface AgentRuntimeModel {
  id: string;
  displayName?: string;
}

export type AgentRuntimeEffort = "low" | "medium" | "high" | "xhigh" | "max";

export interface AgentRuntimeTool {
  id: string;
  displayName?: string;
}

export type AgentRuntimeEventFidelity = "normalized" | "partial" | "native";

export interface AgentRuntimeSession {
  sessionId: string;
  providerSessionId: string | null;
  projectId: string;
  allocationId: string;
  workingDirectory: string;
}

export interface StartAgentRuntimeSession {
  sessionId: string;
  projectId: string;
  allocationId: string;
  workingDirectory: string;
  systemPrompt?: string;
  history?: readonly AgentRuntimeMessage[];
}

export interface ResumeAgentRuntimeSession {
  sessionId: string;
  providerSessionId: string;
  projectId: string;
  allocationId: string;
  workingDirectory: string;
  /** Last event durably persisted by the host for this session. */
  after: AgentEventCursor;
}

export interface StopAgentRuntimeSession {
  sessionId: string;
}

export interface AgentRuntimeMessage {
  messageId?: string;
  role: "user" | "assistant" | "system";
  content: string;
}

export interface StartAgentTurn {
  sessionId: string;
  message: AgentRuntimeMessage;
  model?: string;
  effort?: AgentRuntimeEffort;
}

export interface RetryAgentTurn {
  sessionId: string;
  turnId: string;
  sanitizeReasoning?: boolean;
}

export interface InterruptAgentTurn {
  sessionId: string;
  turnId: string;
  reason?: string;
}

export interface AgentTurnHandle {
  sessionId: string;
  turnId: string;
}

export interface SubscribeToAgentEvents {
  sessionId: string;
  after?: AgentEventCursor;
}

export type AgentRuntimeRequest =
  | AgentApprovalRequest
  | AgentQuestionRequest
  | AgentElicitationRequest;

interface AgentRuntimeRequestBase {
  requestId: string;
  status: "pending" | "resolved" | "expired" | "cancelled";
  sessionId: string;
  turnId?: string;
  createdAt: string;
  expiresAt?: string;
  origin: AgentRuntimeRequestOrigin;
  title: string;
  description?: string;
}

export interface AgentRuntimeRequestOrigin {
  kind: "tool" | "provider" | "mcp" | "host";
  id: string;
  displayName?: string;
}

export interface AgentApprovalRequest extends AgentRuntimeRequestBase {
  kind: "approval";
  approval: {
    action: string;
    details?: string;
  };
}

export interface AgentQuestionRequest extends AgentRuntimeRequestBase {
  kind: "question";
  question: {
    prompt: string;
    options?: readonly AgentQuestionOption[];
    multiple?: boolean;
  };
}

export interface AgentQuestionOption {
  id: string;
  label: string;
  description?: string;
}

export interface AgentElicitationRequest extends AgentRuntimeRequestBase {
  kind: "elicitation";
  elicitation: {
    server: string;
    method: string;
    schema?: Record<string, unknown>;
  };
}

export type AgentRuntimeRequestResponse =
  | { kind: "approval"; decision: "approved" | "denied" }
  | { kind: "question"; answers: readonly string[] }
  | {
      kind: "elicitation";
      action: "accept" | "decline" | "cancel";
      content?: unknown;
    };

export interface RespondToAgentRequest {
  sessionId: string;
  requestId: string;
  response: AgentRuntimeRequestResponse;
}

export interface AgentTask {
  taskId: string;
  sessionId: string;
  turnId?: string;
  parentTaskId?: string;
  title: string;
  description?: string;
  status: AgentTaskStatus;
}

export type AgentTaskStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface ListAgentTasks {
  sessionId: string;
}

export interface ControlAgentTask {
  sessionId: string;
  taskId: string;
  action: "cancel" | "pause" | "resume";
}

interface AgentRuntimeEventBase<Type extends AgentRuntimeEventType> {
  eventId: string;
  /** Allocated by the provider before the event is emitted. */
  sequence: number;
  occurredAt: string;
  sessionId: string;
  turnId?: string;
  providerPayloadRef?: string;
  type: Type;
}

export type AgentRuntimeEventType =
  | "session.started"
  | "session.resumed"
  | "session.stopped"
  | "turn.started"
  | "turn.completed"
  | "turn.failed"
  | "turn.interrupted"
  | "message.delta"
  | "message.completed"
  | "tool.requested"
  | "tool.started"
  | "tool.progressed"
  | "tool.completed"
  | "tool.failed"
  | "tool.cancelled"
  | "request.created"
  | "request.resolved"
  | "plan.replaced"
  | "plan-item.updated"
  | "task.started"
  | "task.updated"
  | "task.completed"
  | "task.failed"
  | "task.cancelled"
  | "subagent.started"
  | "subagent.updated"
  | "subagent.completed"
  | "subagent.failed"
  | "process.started"
  | "process.updated"
  | "process.completed"
  | "watch.started"
  | "watch.updated"
  | "watch.stopped"
  | "workspace.changed"
  | "usage.updated"
  | "diagnostic"
  | "error";

export type AgentRuntimeEvent =
  | (AgentRuntimeEventBase<"session.started" | "session.resumed"> & {
      session: { providerSessionId: string | null };
    })
  | AgentRuntimeEventBase<"session.stopped">
  | AgentRuntimeEventBase<"turn.started" | "turn.completed">
  | (AgentRuntimeEventBase<"turn.failed" | "turn.interrupted"> & {
      reason?: string;
    })
  | (AgentRuntimeEventBase<"message.delta"> & {
      message: { role: AgentRuntimeMessage["role"]; delta: string };
    })
  | (AgentRuntimeEventBase<"message.completed"> & {
      message: AgentRuntimeMessage;
    })
  | (AgentRuntimeEventBase<
      | "tool.requested"
      | "tool.started"
      | "tool.progressed"
      | "tool.completed"
      | "tool.failed"
      | "tool.cancelled"
    > & { tool: AgentRuntimeToolEvent })
  | (AgentRuntimeEventBase<"request.created"> & {
      request: AgentRuntimeRequest;
    })
  | (AgentRuntimeEventBase<"request.resolved"> & {
      requestId: string;
      resolution: AgentRuntimeRequestResponse;
    })
  | (AgentRuntimeEventBase<"plan.replaced" | "plan-item.updated"> & {
      plan: AgentRuntimePlan;
    })
  | (AgentRuntimeEventBase<
      | "task.started"
      | "task.updated"
      | "task.completed"
      | "task.failed"
      | "task.cancelled"
    > & { task: AgentTask })
  | (AgentRuntimeEventBase<
      | "subagent.started"
      | "subagent.updated"
      | "subagent.completed"
      | "subagent.failed"
    > & { subagent: AgentRuntimeSubagent })
  | (AgentRuntimeEventBase<
      "process.started" | "process.updated" | "process.completed"
    > & { process: AgentRuntimeProcess })
  | (AgentRuntimeEventBase<
      "watch.started" | "watch.updated" | "watch.stopped"
    > & {
      watch: AgentRuntimeWatch;
    })
  | (AgentRuntimeEventBase<"workspace.changed"> & {
      changes: readonly AgentRuntimeWorkspaceChange[];
    })
  | (AgentRuntimeEventBase<"usage.updated"> & { usage: AgentRuntimeUsage })
  | (AgentRuntimeEventBase<"diagnostic"> & {
      diagnostic: AgentRuntimeDiagnostic;
    })
  | (AgentRuntimeEventBase<"error"> & { error: AgentRuntimeError });

export interface AgentRuntimeToolEvent {
  toolId: string;
  title?: string;
  progress?: { current?: number; total?: number; message?: string };
  error?: string;
}

export interface AgentRuntimePlan {
  planId: string;
  items: readonly AgentRuntimePlanItem[];
}

export interface AgentRuntimePlanItem {
  id: string;
  title: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
}

export interface AgentRuntimeSubagent {
  subagentId: string;
  title: string;
  status: AgentTaskStatus;
}

export interface AgentRuntimeProcess {
  processId: string;
  status: "running" | "completed" | "failed" | "cancelled";
  command?: string;
}

export interface AgentRuntimeWatch {
  watchId: string;
  status: "active" | "triggered" | "stopped" | "failed";
  title?: string;
}

export interface AgentRuntimeWorkspaceChange {
  path: string;
  kind: "created" | "modified" | "deleted" | "renamed";
  previousPath?: string;
}

export interface AgentRuntimeUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cost?: number;
  model?: string;
  contextWindow?: { used: number; limit?: number };
}

export interface AgentRuntimeDiagnostic {
  level: "debug" | "info" | "warn";
  message: string;
}

export interface AgentRuntimeError {
  message: string;
  fatal: boolean;
  code?: string;
}
