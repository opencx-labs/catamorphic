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
}

export interface SandboxManager {
  ensureExecSandbox(opts: {
    projectId: string;
    commitSha: string;
  }): Promise<SandboxHandle>;

  ensureDevSandbox(opts: {
    projectId: string;
    userId: string;
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
  name: string;
  status: "completed" | "failed" | "skipped";
  input?: unknown;
  output?: unknown;
  error?: string;
  startedAt: string;
  completedAt: string;
}

export interface RunExecutor {
  executeRun(opts: {
    projectId: string;
    workflowName: string;
    triggerData: unknown;
    runId: string;
    commitSha: string;
  }): Promise<RunResult>;
}

export interface AgentEvent {
  type: "text" | "tool_call" | "file_edit" | "command" | "error" | "done";
  content?: string;
  toolName?: string;
  toolInput?: unknown;
  filePath?: string;
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
