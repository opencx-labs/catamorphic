import type {
  AgentRuntimeDescriptor,
  AgentRuntimeEvent,
  AgentRuntimeSession,
  AgentTask,
  AgentTurnHandle,
  ControlAgentTask,
  InterruptAgentTurn,
  ListAgentTasks,
  RespondToAgentRequest,
  ResumeAgentRuntimeSession,
  RetryAgentTurn,
  StartAgentRuntimeSession,
  StartAgentTurn,
  StopAgentRuntimeSession,
  SubscribeToAgentEvents,
} from "./runtime-types.js";

export interface AgentRuntimeProvider {
  readonly name: string;
  describe(args: Record<string, never>): Promise<AgentRuntimeDescriptor>;
  startSession(args: StartAgentRuntimeSession): Promise<AgentRuntimeSession>;
  resumeSession(args: ResumeAgentRuntimeSession): Promise<AgentRuntimeSession>;
  stopSession(args: StopAgentRuntimeSession): Promise<void>;
  startTurn(args: StartAgentTurn): Promise<AgentTurnHandle>;
  retryTurn(args: RetryAgentTurn): Promise<AgentTurnHandle>;
  interruptTurn(args: InterruptAgentTurn): Promise<void>;
  respond(args: RespondToAgentRequest): Promise<void>;
  subscribe(args: SubscribeToAgentEvents): AsyncIterable<AgentRuntimeEvent>;
  listTasks(args: ListAgentTasks): Promise<readonly AgentTask[]>;
  controlTask(args: ControlAgentTask): Promise<void>;
}

export type AgentRuntimeOperation =
  | "resumeSession"
  | "retryTurn"
  | "interruptTurn"
  | "respond"
  | "listTasks"
  | "controlTask";

/** Raised when a descriptor truthfully declares that an operation is absent. */
export class AgentRuntimeUnsupportedError extends Error {
  constructor(args: { provider: string; operation: AgentRuntimeOperation }) {
    super(
      `Agent runtime '${args.provider}' does not support ${args.operation}`,
    );
    this.name = "AgentRuntimeUnsupportedError";
  }
}
