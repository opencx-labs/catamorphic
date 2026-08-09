import type {
  RuntimeArtifactIdentity,
  RuntimeBatchStepSuspension,
  RuntimeInvocationEvent,
  RuntimeInvocationEventsResponse,
  RuntimeInvocationRequest,
  RuntimeStepEntry,
  RuntimeSupervisorHealth,
  RuntimeTerminalResult,
} from "@catamorphic/runtime";

export type SandboxType = "execution" | "dev";

export type SandboxStatus =
  | "creating"
  | "started"
  | "stopped"
  | "archived"
  | "error";

export interface SandboxHandle {
  id: string;
  providerId: string;
  sandboxType: SandboxType;
  status: SandboxStatus;
}

export interface CreateSandboxOpts {
  snapshotName?: string;
  language?: string;
  envVars?: Record<string, string>;
  autoStopInterval?: number;
  labels?: Record<string, string>;
}

export interface ExecOpts {
  cwd?: string;
  timeout?: number;
  env?: Record<string, string>;
}

export interface ExecResult {
  exitCode: number;
  result: string;
}

export interface GitCloneOpts {
  branch?: string;
  commitId?: string;
  username?: string;
  password?: string;
}

export interface SandboxProvider {
  /**
   * Absolute directory inside the sandbox where provider-agnostic callers
   * should upload project files / run commands. Each provider's container
   * image convention wins (Daytona: `/home/daytona`, Cloudflare: `/workspace`).
   */
  readonly workspaceRoot: string;

  createSandbox(opts: CreateSandboxOpts): Promise<SandboxHandle>;
  startSandbox(sandboxId: string): Promise<void>;
  stopSandbox(sandboxId: string): Promise<void>;
  destroySandbox(sandboxId: string): Promise<void>;
  getSandboxStatus(sandboxId: string): Promise<SandboxStatus>;
  executeCommand(
    sandboxId: string,
    command: string,
    opts?: ExecOpts,
  ): Promise<ExecResult>;
  uploadFiles(
    sandboxId: string,
    files: Record<string, string>,
    basePath: string,
  ): Promise<void>;
  downloadFile(sandboxId: string, filePath: string): Promise<string>;
  gitClone(
    sandboxId: string,
    url: string,
    path: string,
    opts?: GitCloneOpts,
  ): Promise<void>;
  gitCheckout(sandboxId: string, path: string, ref: string): Promise<void>;

  /**
   * Optional warm deployment-runtime capability. Existing providers can omit
   * it and continue using command-based execution.
   */
  readonly deploymentRuntime?: DeploymentRuntimeProvider;
}

export type DeploymentRuntimeStatus =
  | "starting"
  | "healthy"
  | "stopped"
  | "error";

export interface DeploymentRuntime {
  runtimeId: string;
  sandboxId: string;
  deploymentArtifactId: string;
  artifactDigest: string;
  transformVersion: string;
  runtimeVersion: string;
  generation: string;
  status: DeploymentRuntimeStatus;
}

export interface EnsureDeploymentRuntimeArgs extends RuntimeArtifactIdentity {
  sandboxId: string;
  workingDirectory: string;
  maxConcurrency?: number;
  env?: Record<string, string>;
}

export type RuntimeInvocation = RuntimeInvocationRequest & {
  runtimeId: string;
  eventSink?: RuntimeInvocationEventSink;
  signal?: AbortSignal;
};

/**
 * A runtime handoff or provider failure, distinct from a terminal result
 * produced by workflow code. Retrying may execute external effects again, so
 * workflow and batch effects remain at-least-once and must be idempotent.
 */
export class RuntimeInfrastructureError extends Error {
  constructor(args: { operation: string; cause: unknown }) {
    super(
      `Runtime infrastructure failed during ${args.operation}: ${errorMessage(args.cause)}`,
      { cause: args.cause },
    );
    this.name = "RuntimeInfrastructureError";
  }
}

export interface RuntimeInvocationEventBatch {
  runtimeId: string;
  invocationId: string;
  events: readonly RuntimeInvocationEvent[];
}

export interface RuntimeInvocationEventSink {
  report(args: RuntimeInvocationEventBatch): Promise<void>;
}

export class RuntimeEventReportingError extends RuntimeInfrastructureError {
  constructor(args: { invocationId: string; cause: unknown }) {
    super({
      operation: `event reporting for invocation '${args.invocationId}'`,
      cause: args.cause,
    });
    this.name = "RuntimeEventReportingError";
  }
}

export interface RuntimeInvocationReceipt {
  runtimeId: string;
  invocationId: string;
  events: readonly RuntimeInvocationEvent[];
  terminal: RuntimeTerminalResult;
}

export interface CancelRuntimeInvocationArgs {
  runtimeId: string;
  invocationId: string;
}

export interface GetRuntimeHealthArgs {
  runtimeId: string;
}

export interface RuntimeHealth extends RuntimeSupervisorHealth {
  runtimeId: string;
  runtimeStatus: DeploymentRuntimeStatus;
}

export interface DeploymentRuntimeProvider {
  ensureRuntime(args: EnsureDeploymentRuntimeArgs): Promise<DeploymentRuntime>;
  /**
   * Uses invocationId for supervisor deduplication. A caller that cannot
   * recover the original receipt may retry execution with a new invocationId;
   * external effects are therefore delivered at least once.
   */
  invoke(args: RuntimeInvocation): Promise<RuntimeInvocationReceipt>;
  cancel(args: CancelRuntimeInvocationArgs): Promise<void>;
  getHealth(args: GetRuntimeHealthArgs): Promise<RuntimeHealth>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type {
  RuntimeArtifactIdentity,
  RuntimeBatchStepSuspension,
  RuntimeInvocationEvent,
  RuntimeInvocationEventsResponse,
  RuntimeInvocationRequest,
  RuntimeStepEntry,
  RuntimeTerminalResult,
};

/**
 * Instruction for populating a sandbox's project directory via `git clone`
 * from a real git remote (e.g. Cloudflare Artifacts) instead of uploading
 * files from the host. Produced by remote backends that expose
 * `getCloneSource` (see `@catamorphic/git`).
 */
export interface CloneSource {
  url: string;
  username?: string;
  password?: string;
  branch?: string;
  /** Commit to check out after cloning (exec sandboxes pin to a SHA). */
  commitSha?: string;
}

export interface SandboxManager {
  ensureExecSandbox(opts: {
    projectId: string;
    commitSha: string;
    /** When set, freshly created sandboxes clone the project from git. */
    cloneSource?: CloneSource;
  }): Promise<SandboxHandle>;

  ensureDevSandbox(opts: {
    projectId: string;
    userId: string;
    /** When set, freshly created sandboxes clone the project from git. */
    cloneSource?: CloneSource;
  }): Promise<SandboxHandle>;

  releaseSandbox(sandboxId: string): Promise<void>;
}

export interface RunResult {
  status: "completed" | "failed";
  result?: unknown;
  error?: string;
  steps: StepEntry[];
}

export interface StepEntry {
  nodeId: string;
  occurrence?: number;
  name: string;
  status: "completed" | "failed" | "skipped";
  attempt?: number;
  input?: unknown;
  output?: unknown;
  error?: string;
  startedAt: string;
  completedAt: string;
}

/**
 * Plugin package materialized for run-time upload. `files` maps paths
 * relative to the package root (e.g. `package.json`, `dist/index.js`) to
 * their UTF-8 contents.
 */
export interface RunPluginPayload {
  packageName: string;
  files: Record<string, string>;
}

export interface RunExecutor {
  executeRun(opts: {
    sandboxId: string;
    workingDirectory: string;
    workflowFile: string;
    workflowName: string;
    triggerData: unknown;
    runId: string;
    plugins?: RunPluginPayload[];
    secrets?: Record<string, string>;
  }): Promise<RunResult>;
}

export interface AgentQuestionOption {
  /** Concise display label (1-5 words). */
  label: string;
  /** Explanation of what this option means or implies. */
  description: string;
}

export interface AgentQuestion {
  /** The complete question, e.g. "Which library should we use?" */
  question: string;
  /** Very short chip/tag label (max ~12 chars), e.g. "Auth method". */
  header: string;
  /** Whether multiple options may be selected. */
  multiSelect: boolean;
  options: AgentQuestionOption[];
}

/**
 * Classified failure category on "error" events. Drives recovery UX:
 * `auth` offers a re-connect path, `rate_limit`/`unavailable` auto-retry
 * with backoff, `model_incompat` (e.g. reasoning blocks signed by another
 * model after a mid-conversation switch) retries with sanitized history.
 * Unclassified errors just offer a manual retry.
 */
export type AgentErrorKind =
  | "auth"
  | "rate_limit"
  | "unavailable"
  | "model_incompat";

export interface AgentEvent {
  type:
    | "text"
    | "tool_call"
    | "file_edit"
    | "command"
    | "question"
    | "title"
    | "session"
    | "error"
    | "done";
  content?: string;
  toolName?: string;
  toolInput?: unknown;
  filePath?: string;
  /** Set on "question" events: the agent is pausing for user input. */
  questions?: AgentQuestion[];
  /**
   * Set on "session" events: the harness's native session id, reported by
   * providers that only learn it once the first turn starts (Codex). The
   * host persists it and passes it back on later turns; the event is an
   * anchoring signal, never turn content.
   */
  providerSessionId?: string;
  /** Set on classified "error" events (see {@link AgentErrorKind}). */
  errorKind?: AgentErrorKind;
}

export interface AgentSession {
  sessionId: string;
  threadId: string;
  projectId: string;
  userId: string;
  sandboxId: string;
}

export interface SessionInfo {
  sessionId: string;
  projectId: string;
  userId: string;
  status: "active" | "closed";
  baseCommitSha: string | null;
  title: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CodingAgent {
  startSession(opts: {
    projectId: string;
    userId: string;
    systemPrompt?: string;
  }): Promise<AgentSession>;

  resumeSession(sessionId: string): Promise<AgentSession>;

  sendMessage(opts: {
    sessionId: string;
    message: string;
  }): AsyncIterable<AgentEvent>;

  getSessionInfo(sessionId: string): Promise<SessionInfo>;
}
