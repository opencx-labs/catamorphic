import path from "node:path";
import type {
  AgentApprovalRequest,
  AgentQuestionRequest,
  AgentRuntimeDescriptor,
  AgentRuntimeEvent,
  AgentRuntimeProvider,
  AgentRuntimeRequest,
  AgentRuntimeRequestResponse,
  AgentRuntimeSession,
  AgentTask,
  AgentTurnHandle,
  ExtraTool,
  ExtraToolContext,
  SandboxProvider,
  StartAgentRuntimeSession,
  StartAgentTurn,
  SubscribeToAgentEvents,
} from "@catamorphic/sandbox";
import { AgentRuntimeUnsupportedError } from "@catamorphic/sandbox";
import {
  type LanguageModel,
  type ModelMessage,
  stepCountIs,
  ToolLoopAgent,
  tool,
} from "ai";
import { z } from "zod";

const DEFAULT_INSTRUCTIONS = `You are working in a Catamorphic project, a folder that can hold documents, notes, data, code, automations, and apps.
Use the available tools to inspect and edit the project in your working directory.
Read AGENTS.md and relevant .agents/skills/*/SKILL.md files before substantial changes.
Keep changes focused, run relevant checks, and do not commit changes.`;

export interface AiSdkToolPolicyRequest {
  sessionId: string;
  turnId: string;
  toolName: string;
  input: unknown;
}

export type AiSdkToolPolicyDecision =
  | { decision: "allow" }
  | { decision: "deny"; reason?: string }
  | { decision: "ask"; title?: string; description?: string };

export interface AiSdkAgentRuntimeOpts {
  model: LanguageModel;
  sandboxProvider: SandboxProvider;
  instructions?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  resolveModel?: (modelId: string) => LanguageModel;
  extraTools?: readonly ExtraTool[];
  decideToolUse?: (
    request: AiSdkToolPolicyRequest,
  ) => AiSdkToolPolicyDecision | Promise<AiSdkToolPolicyDecision>;
}

interface EventBase {
  eventId: string;
  sequence: number;
  occurredAt: string;
  sessionId: string;
  turnId?: string;
  providerPayloadRef?: string;
}

interface Subscriber {
  queue: AgentRuntimeEvent[];
  closed: boolean;
  wake?: () => void;
}

interface PendingRequest {
  request: AgentRuntimeRequest;
  resolve: (response: AgentRuntimeRequestResponse) => void;
  response: Promise<AgentRuntimeRequestResponse>;
}

interface ActiveTurn {
  turnId: string;
  abort: AbortController;
  message: ModelMessage;
  interrupted: boolean;
}

type PendingTurnRequest =
  | {
      kind: "question";
      request: Promise<AgentRuntimeRequestResponse>;
      toolCallId: string;
    }
  | {
      kind: "approval";
      request: Promise<AgentRuntimeRequestResponse>;
      approvalId: string;
    };

interface AiSdkRuntimeSessionState {
  session: AgentRuntimeSession;
  instructions: string;
  transcript: ModelMessage[];
  tools: ReturnType<typeof createTools>;
  events: AgentRuntimeEvent[];
  subscribers: Set<Subscriber>;
  requests: Map<string, PendingRequest>;
  sequence: number;
  stopped: boolean;
  activeTurn?: ActiveTurn;
}

/**
 * Long-lived runtime adapter for the AI SDK tool loop. Commands and event
 * delivery are deliberately independent: turns run in the background while
 * subscribers replay or follow the per-session event buffer.
 */
export class AiSdkAgentRuntime implements AgentRuntimeProvider {
  readonly name = "ai-sdk";
  private readonly sessions = new Map<string, AiSdkRuntimeSessionState>();

  constructor(private readonly opts: AiSdkAgentRuntimeOpts) {}

  async describe(): Promise<AgentRuntimeDescriptor> {
    const modelId = modelIdOf(this.opts.model);
    return {
      id: this.name,
      displayName: "AI SDK Agent",
      placement: "control_plane",
      resumability: false,
      operations: {
        resumeSession: false,
        retryTurn: false,
        interruptTurn: true,
      },
      capabilities: {
        approvals: true,
        questions: true,
        elicitations: false,
        plans: false,
        tasks: false,
        subagents: false,
        usage: true,
        dynamicTools: true,
      },
      models: modelId ? [{ id: modelId }] : [],
      efforts: ["low", "medium", "high", "xhigh", "max"],
      builtInTools: [
        { id: "read", displayName: "Read" },
        { id: "write", displayName: "Write" },
        { id: "edit", displayName: "Edit" },
        { id: "bash", displayName: "Bash" },
        { id: "ask_user", displayName: "Ask User" },
      ],
      mcpGenerations: [],
      eventFidelity: "normalized",
    };
  }

  async startSession(
    args: StartAgentRuntimeSession,
  ): Promise<AgentRuntimeSession> {
    if (this.sessions.has(args.sessionId)) {
      throw new Error(
        `Agent runtime session already exists: ${args.sessionId}`,
      );
    }
    const session: AgentRuntimeSession = {
      sessionId: args.sessionId,
      providerSessionId: null,
      projectId: args.projectId,
      allocationId: args.allocationId,
      workingDirectory: args.workingDirectory,
    };
    const toolContext: ExtraToolContext = {
      projectId: args.projectId,
      sessionId: args.sessionId,
      workingDirectory: args.workingDirectory,
    };
    const state: AiSdkRuntimeSessionState = {
      session,
      instructions: [
        DEFAULT_INSTRUCTIONS,
        this.opts.instructions,
        args.systemPrompt,
      ]
        .filter((part): part is string => Boolean(part))
        .join("\n\n"),
      transcript: (args.history ?? []).map((message) => ({
        role: message.role,
        content: message.content,
      })),
      tools: createTools({
        provider: this.opts.sandboxProvider,
        session,
        extraTools: this.opts.extraTools ?? [],
        toolContext,
      }),
      events: [],
      subscribers: new Set(),
      requests: new Map(),
      sequence: 0,
      stopped: false,
    };
    this.sessions.set(args.sessionId, state);
    this.publish(state, {
      eventId: `ai-sdk:session:${args.sessionId}:started`,
      build: (base) => ({
        ...base,
        type: "session.started",
        session: { providerSessionId: session.providerSessionId },
      }),
    });
    this.publish(state, {
      eventId: `ai-sdk:session:${args.sessionId}:initialized`,
      build: (base) => ({
        ...base,
        type: "diagnostic",
        diagnostic: {
          level: "info",
          message: "AI SDK session initialized",
        },
      }),
    });
    return session;
  }

  async resumeSession(): Promise<AgentRuntimeSession> {
    throw new AgentRuntimeUnsupportedError({
      provider: this.name,
      operation: "resumeSession",
    });
  }

  async stopSession(args: { sessionId: string }): Promise<void> {
    const state = this.requireSession(args.sessionId);
    if (state.stopped) return;
    state.activeTurn?.abort.abort("Session stopped");
    if (state.activeTurn) {
      this.cancelRequestsForTurn(state, state.activeTurn.turnId);
    }
    state.stopped = true;
    this.publish(state, {
      eventId: `ai-sdk:session:${args.sessionId}:stopped`,
      build: (base) => ({ ...base, type: "session.stopped" }),
    });
    for (const subscriber of state.subscribers) {
      subscriber.closed = true;
      subscriber.wake?.();
    }
  }

  async startTurn(args: StartAgentTurn): Promise<AgentTurnHandle> {
    const state = this.requireSession(args.sessionId);
    if (state.stopped) throw new Error("The agent runtime session is stopped");
    if (state.activeTurn) {
      throw new Error("A turn is already active for this session");
    }
    const turnId = crypto.randomUUID();
    const message: ModelMessage = {
      role: args.message.role,
      content: args.message.content,
    };
    const activeTurn: ActiveTurn = {
      turnId,
      abort: new AbortController(),
      message,
      interrupted: false,
    };
    state.activeTurn = activeTurn;
    state.transcript.push(message);
    this.publish(state, {
      eventId: `ai-sdk:turn:${turnId}:started`,
      build: (base) => ({ ...base, type: "turn.started" }),
    });
    void this.runTurn({
      state,
      turn: activeTurn,
      model: args.model,
      effort: args.effort,
    });
    return { sessionId: args.sessionId, turnId };
  }

  async retryTurn(): Promise<AgentTurnHandle> {
    throw new AgentRuntimeUnsupportedError({
      provider: this.name,
      operation: "retryTurn",
    });
  }

  async interruptTurn(args: {
    sessionId: string;
    turnId: string;
    reason?: string;
  }): Promise<void> {
    const state = this.requireSession(args.sessionId);
    const turn = state.activeTurn;
    if (!turn || turn.turnId !== args.turnId) {
      throw new Error(`Active turn not found: ${args.turnId}`);
    }
    turn.interrupted = true;
    turn.abort.abort(args.reason ?? "Interrupted by the host");
    this.cancelRequestsForTurn(state, turn.turnId);
    this.publish(state, {
      eventId: `ai-sdk:turn:${turn.turnId}:interrupted`,
      build: (base) => ({
        ...base,
        type: "turn.interrupted",
        ...(args.reason ? { reason: args.reason } : {}),
      }),
    });
  }

  async respond(args: {
    sessionId: string;
    requestId: string;
    response: AgentRuntimeRequestResponse;
  }): Promise<void> {
    const state = this.requireSession(args.sessionId);
    const pending = state.requests.get(args.requestId);
    if (!pending)
      throw new Error(`Pending agent request not found: ${args.requestId}`);
    if (pending.request.kind !== args.response.kind) {
      throw new Error(
        `Response kind ${args.response.kind} does not match ${pending.request.kind}`,
      );
    }
    this.resolvePendingRequest(state, pending, args.response);
  }

  private resolvePendingRequest(
    state: AiSdkRuntimeSessionState,
    pending: PendingRequest,
    response: AgentRuntimeRequestResponse,
  ): void {
    if (!state.requests.delete(pending.request.requestId)) return;
    this.publish(state, {
      eventId: `ai-sdk:request:${pending.request.requestId}:resolved`,
      turnId: pending.request.turnId,
      build: (base) => ({
        ...base,
        type: "request.resolved",
        requestId: pending.request.requestId,
        resolution: response,
      }),
    });
    pending.resolve(response);
  }

  private cancelRequestsForTurn(
    state: AiSdkRuntimeSessionState,
    turnId: string,
  ): void {
    for (const pending of [...state.requests.values()]) {
      if (pending.request.turnId !== turnId) continue;
      this.resolvePendingRequest(
        state,
        pending,
        cancelledResponse(pending.request),
      );
    }
  }

  async *subscribe(
    args: SubscribeToAgentEvents,
  ): AsyncIterable<AgentRuntimeEvent> {
    const state = this.requireSession(args.sessionId);
    const after = args.after?.sequence ?? 0;
    const replay = state.events.filter((event) => event.sequence > after);
    const subscriber: Subscriber = { queue: [], closed: false };
    state.subscribers.add(subscriber);
    try {
      for (const event of replay) yield event;
      while (true) {
        const event = subscriber.queue.shift();
        if (event) {
          yield event;
          continue;
        }
        if (subscriber.closed) break;
        await new Promise<void>((resolve) => {
          subscriber.wake = resolve;
        });
        subscriber.wake = undefined;
      }
    } finally {
      state.subscribers.delete(subscriber);
    }
  }

  async listTasks(): Promise<readonly AgentTask[]> {
    throw new AgentRuntimeUnsupportedError({
      provider: this.name,
      operation: "listTasks",
    });
  }

  async controlTask(): Promise<void> {
    throw new AgentRuntimeUnsupportedError({
      provider: this.name,
      operation: "controlTask",
    });
  }

  private async runTurn(args: {
    state: AiSdkRuntimeSessionState;
    turn: ActiveTurn;
    model?: string;
    effort?: "low" | "medium" | "high" | "xhigh" | "max";
  }): Promise<void> {
    const { state, turn } = args;
    let continuation = true;
    let iteration = 0;
    let cumulativeUsage: MappedUsage | undefined;
    try {
      while (continuation && !turn.interrupted) {
        iteration += 1;
        continuation = false;
        let text = "";
        let completedText = false;
        const model =
          args.model && this.opts.resolveModel
            ? this.opts.resolveModel(args.model)
            : this.opts.model;
        const effort = args.effort ?? this.opts.effort;
        const agent = new ToolLoopAgent({
          model,
          instructions: state.instructions,
          tools: state.tools,
          stopWhen: stepCountIs(150),
          ...(effort ? { providerOptions: effortProviderOptions(effort) } : {}),
          ...(this.opts.decideToolUse
            ? {
                toolApproval: async ({ toolCall }) => {
                  if (toolCall.toolName === "ask_user") return "approved";
                  const decision = await this.opts.decideToolUse?.({
                    sessionId: state.session.sessionId,
                    turnId: turn.turnId,
                    toolName: toolCall.toolName,
                    input: toolCall.input,
                  });
                  if (!decision || decision.decision === "allow") {
                    return "approved";
                  }
                  return decision.decision === "deny"
                    ? { type: "denied", reason: decision.reason }
                    : "user-approval";
                },
              }
            : {}),
        });
        const result = await agent.stream({
          messages: state.transcript,
          abortSignal: turn.abort.signal,
        });
        const pending: PendingTurnRequest[] = [];
        const toolCalls = new Map<
          string,
          { toolName: string; input: unknown }
        >();
        for await (const part of result.stream) {
          if (part.type === "text-delta") {
            text += part.text;
            this.publish(state, {
              eventId: `ai-sdk:${turn.turnId}:text:${part.id}:${text.length}`,
              build: (base) => ({
                ...base,
                type: "message.delta",
                message: { role: "assistant", delta: part.text },
              }),
            });
            continue;
          }
          if (part.type === "text-end" && text.length > 0) {
            this.publish(state, {
              eventId: `ai-sdk:${turn.turnId}:message:${iteration}:${part.id}:completed`,
              build: (base) => ({
                ...base,
                type: "message.completed",
                message: { role: "assistant", content: text },
              }),
            });
            completedText = true;
            continue;
          }
          if (part.type === "tool-input-start") {
            this.publishTool(state, turn, "tool.requested", {
              toolId: part.id,
              title: part.title ?? part.toolName,
            });
            continue;
          }
          if (part.type === "tool-input-delta") {
            this.publishTool(state, turn, "tool.progressed", {
              toolId: part.id,
              progress: { message: part.delta },
            });
            continue;
          }
          if (part.type === "tool-call") {
            toolCalls.set(part.toolCallId, {
              toolName: part.toolName,
              input: part.input,
            });
            this.publishTool(state, turn, "tool.started", {
              toolId: part.toolCallId,
              title: part.toolName,
            });
            if (part.toolName === "ask_user") {
              const request = this.createQuestionRequest({
                state,
                turn,
                toolCallId: part.toolCallId,
                input: part.input,
              });
              pending.push({
                kind: "question",
                request,
                toolCallId: part.toolCallId,
              });
            }
            continue;
          }
          if (part.type === "tool-result") {
            this.publishTool(state, turn, "tool.completed", {
              toolId: part.toolCallId,
              title: part.toolName,
            });
            const toolCall = toolCalls.get(part.toolCallId);
            if (toolCall) {
              this.publishWorkspaceChange(
                state,
                turn,
                toolCall.toolName,
                toolCall.input,
              );
              toolCalls.delete(part.toolCallId);
            }
            continue;
          }
          if (part.type === "tool-error") {
            this.publishTool(state, turn, "tool.failed", {
              toolId: part.toolCallId,
              title: part.toolName,
              error: errorMessage(part.error),
            });
            continue;
          }
          if (part.type === "tool-approval-request") {
            if (!part.isAutomatic) {
              pending.push({
                kind: "approval",
                request: this.createApprovalRequest({
                  state,
                  turn,
                  requestId: part.approvalId,
                  toolName: part.toolCall.toolName,
                }),
                approvalId: part.approvalId,
              });
            }
            continue;
          }
          if (part.type === "tool-approval-response") {
            if (!part.approved) {
              this.publishTool(state, turn, "tool.failed", {
                toolId: part.toolCall.toolCallId,
                title: part.toolCall.toolName,
                error: part.reason ?? "Tool use was denied",
              });
            }
            continue;
          }
          if (part.type === "abort") {
            turn.interrupted = true;
            this.cancelRequestsForTurn(state, turn.turnId);
            continue;
          }
          if (part.type === "error") throw part.error;
        }
        state.transcript.push(...(await result.responseMessages));
        const usage = await result.totalUsage;
        const mappedUsage = mapUsage(usage, args.model ?? modelIdOf(model));
        if (mappedUsage) {
          const nextUsage = accumulateUsage(cumulativeUsage, mappedUsage);
          cumulativeUsage = nextUsage;
          this.publish(state, {
            eventId: `ai-sdk:${turn.turnId}:usage:${iteration}`,
            build: (base) => ({
              ...base,
              type: "usage.updated",
              usage: nextUsage,
            }),
          });
        }
        if (pending.length > 0) {
          const responses = await Promise.all(
            pending.map(async (entry) => ({
              entry,
              response: await entry.request,
            })),
          );
          for (const { entry, response } of responses) {
            if (entry.kind === "question") {
              if (response.kind !== "question") {
                throw new Error("Question response kind changed while pending");
              }
              state.transcript.push({
                role: "tool",
                content: [
                  {
                    type: "tool-result",
                    toolCallId: entry.toolCallId,
                    toolName: "ask_user",
                    output: {
                      type: "text",
                      value: response.answers.join("\n"),
                    },
                  },
                ],
              });
              this.publishTool(state, turn, "tool.completed", {
                toolId: entry.toolCallId,
                title: "ask_user",
              });
              continue;
            }
            if (response.kind !== "approval") {
              throw new Error("Approval response kind changed while pending");
            }
            state.transcript.push({
              role: "tool",
              content: [
                {
                  type: "tool-approval-response",
                  approvalId: entry.approvalId,
                  approved: response.decision === "approved",
                },
              ],
            });
          }
          continuation = true;
          continue;
        }
        if (text.length > 0 && !completedText) {
          this.publish(state, {
            eventId: `ai-sdk:${turn.turnId}:message:${iteration}:completed`,
            build: (base) => ({
              ...base,
              type: "message.completed",
              message: { role: "assistant", content: text },
            }),
          });
        }
      }
      if (!turn.interrupted) {
        this.cancelRequestsForTurn(state, turn.turnId);
        this.publish(state, {
          eventId: `ai-sdk:turn:${turn.turnId}:completed`,
          build: (base) => ({ ...base, type: "turn.completed" }),
        });
      }
    } catch (error) {
      this.cancelRequestsForTurn(state, turn.turnId);
      if (!turn.interrupted) {
        const message = errorMessage(error);
        this.publish(state, {
          eventId: `ai-sdk:turn:${turn.turnId}:error`,
          build: (base) => ({
            ...base,
            type: "error",
            error: { message, fatal: false },
          }),
        });
        this.publish(state, {
          eventId: `ai-sdk:turn:${turn.turnId}:failed`,
          build: (base) => ({ ...base, type: "turn.failed", reason: message }),
        });
      }
    } finally {
      this.cancelRequestsForTurn(state, turn.turnId);
      if (state.activeTurn === turn) state.activeTurn = undefined;
    }
  }

  private createQuestionRequest(args: {
    state: AiSdkRuntimeSessionState;
    turn: ActiveTurn;
    toolCallId: string;
    input: unknown;
  }): Promise<AgentRuntimeRequestResponse> {
    const question = firstQuestion(args.input);
    const request: AgentQuestionRequest = {
      requestId: args.toolCallId,
      kind: "question",
      status: "pending",
      sessionId: args.state.session.sessionId,
      turnId: args.turn.turnId,
      createdAt: new Date().toISOString(),
      origin: { kind: "tool", id: "ask_user", displayName: "Ask User" },
      title: question.header,
      question: {
        prompt: question.prompt,
        options: question.options,
        multiple: question.multiple,
      },
    };
    return this.parkRequest(args.state, request);
  }

  private createApprovalRequest(args: {
    state: AiSdkRuntimeSessionState;
    turn: ActiveTurn;
    requestId: string;
    toolName: string;
  }): Promise<AgentRuntimeRequestResponse> {
    const request: AgentApprovalRequest = {
      requestId: args.requestId,
      kind: "approval",
      status: "pending",
      sessionId: args.state.session.sessionId,
      turnId: args.turn.turnId,
      createdAt: new Date().toISOString(),
      origin: { kind: "tool", id: args.toolName },
      title: `Allow ${args.toolName}?`,
      approval: { action: args.toolName },
    };
    return this.parkRequest(args.state, request);
  }

  private parkRequest(
    state: AiSdkRuntimeSessionState,
    request: AgentRuntimeRequest,
  ): Promise<AgentRuntimeRequestResponse> {
    let resolveResponse:
      | ((response: AgentRuntimeRequestResponse) => void)
      | undefined;
    const response = new Promise<AgentRuntimeRequestResponse>((resolve) => {
      resolveResponse = resolve;
    });
    if (!resolveResponse) throw new Error("Failed to create request resolver");
    state.requests.set(request.requestId, {
      request,
      resolve: resolveResponse,
      response,
    });
    this.publish(state, {
      eventId: `ai-sdk:request:${request.requestId}:created`,
      turnId: request.turnId,
      build: (base) => ({ ...base, type: "request.created", request }),
    });
    return response;
  }

  private publishTool(
    state: AiSdkRuntimeSessionState,
    turn: ActiveTurn,
    type:
      | "tool.requested"
      | "tool.started"
      | "tool.progressed"
      | "tool.completed"
      | "tool.failed",
    toolEvent: {
      toolId: string;
      title?: string;
      progress?: { message?: string };
      error?: string;
    },
  ): void {
    this.publish(state, {
      eventId: `ai-sdk:${turn.turnId}:${type}:${toolEvent.toolId}:${state.sequence + 1}`,
      build: (base) => ({ ...base, type, tool: toolEvent }),
    });
  }

  private publishWorkspaceChange(
    state: AiSdkRuntimeSessionState,
    turn: ActiveTurn,
    toolName: string,
    input: unknown,
  ): void {
    if (toolName !== "write" && toolName !== "edit") return;
    const values = recordOf(input);
    const filePath = values?.path;
    if (typeof filePath !== "string") return;
    this.publish(state, {
      eventId: `ai-sdk:${turn.turnId}:workspace:${toolName}:${filePath}`,
      build: (base) => ({
        ...base,
        type: "workspace.changed",
        changes: [
          {
            path: filePath,
            kind: toolName === "write" ? "created" : "modified",
          },
        ],
      }),
    });
  }

  private publish(
    state: AiSdkRuntimeSessionState,
    args: {
      eventId: string;
      turnId?: string;
      providerPayloadRef?: string;
      build: (base: EventBase) => AgentRuntimeEvent;
    },
  ): void {
    const sequence = state.sequence + 1;
    state.sequence = sequence;
    const activeTurnId = args.turnId ?? state.activeTurn?.turnId;
    const base: EventBase = {
      eventId: args.eventId,
      sequence,
      occurredAt: new Date().toISOString(),
      sessionId: state.session.sessionId,
      ...(activeTurnId ? { turnId: activeTurnId } : {}),
      ...(args.providerPayloadRef
        ? { providerPayloadRef: args.providerPayloadRef }
        : {}),
    };
    const event = args.build(base);
    state.events.push(event);
    for (const subscriber of state.subscribers) {
      subscriber.queue.push(event);
      subscriber.wake?.();
    }
  }

  private requireSession(sessionId: string): AiSdkRuntimeSessionState {
    const state = this.sessions.get(sessionId);
    if (!state)
      throw new Error(`Agent runtime session not found: ${sessionId}`);
    return state;
  }
}

function createTools(args: {
  provider: SandboxProvider;
  session: AgentRuntimeSession;
  extraTools: readonly ExtraTool[];
  toolContext: ExtraToolContext;
}) {
  const workingDirectory = path.posix.resolve(args.session.workingDirectory);
  const resolvePath = (filePath: string): string => {
    const resolved = path.posix.resolve(workingDirectory, filePath);
    if (
      resolved !== workingDirectory &&
      !resolved.startsWith(`${workingDirectory}/`)
    ) {
      throw new Error(
        `Path escapes the project working directory: ${filePath}`,
      );
    }
    return resolved;
  };
  return {
    ...Object.fromEntries(
      args.extraTools.map((definition) => [
        definition.name,
        tool({
          description: definition.description,
          inputSchema: z.object(definition.parameters as z.ZodRawShape),
          execute: (input: Record<string, unknown>) =>
            definition.execute(input, args.toolContext),
        }),
      ]),
    ),
    read: tool({
      description: "Read a UTF-8 text file from the project.",
      inputSchema: z.object({ path: z.string() }),
      execute: ({ path: filePath }) =>
        args.provider.downloadFile(
          args.session.allocationId,
          resolvePath(filePath),
        ),
    }),
    write: tool({
      description: "Create or replace a UTF-8 text file in the project.",
      inputSchema: z.object({ path: z.string(), content: z.string() }),
      execute: async ({ path: filePath, content }) => {
        const absolutePath = resolvePath(filePath);
        const relativePath = path.posix.relative(
          workingDirectory,
          absolutePath,
        );
        await args.provider.uploadFiles(
          args.session.allocationId,
          { [relativePath]: content },
          workingDirectory,
        );
        return `Wrote ${relativePath}`;
      },
    }),
    edit: tool({
      description: "Replace one exact string occurrence in a project file.",
      inputSchema: z.object({
        path: z.string(),
        oldText: z.string(),
        newText: z.string(),
      }),
      execute: async ({ path: filePath, oldText, newText }) => {
        const absolutePath = resolvePath(filePath);
        const content = await args.provider.downloadFile(
          args.session.allocationId,
          absolutePath,
        );
        const first = content.indexOf(oldText);
        if (first === -1) throw new Error(`Text not found in ${filePath}`);
        if (content.indexOf(oldText, first + oldText.length) !== -1) {
          throw new Error(`Text occurs more than once in ${filePath}`);
        }
        const updated = `${content.slice(0, first)}${newText}${content.slice(first + oldText.length)}`;
        const relativePath = path.posix.relative(
          workingDirectory,
          absolutePath,
        );
        await args.provider.uploadFiles(
          args.session.allocationId,
          { [relativePath]: updated },
          workingDirectory,
        );
        return `Edited ${relativePath}`;
      },
    }),
    bash: tool({
      description: "Run a command in the project working directory.",
      inputSchema: z.object({
        command: z.string(),
        timeoutMs: z.number().int().positive().optional(),
      }),
      execute: ({ command, timeoutMs }) =>
        args.provider.executeCommand(args.session.allocationId, command, {
          cwd: workingDirectory,
          ...(timeoutMs ? { timeout: Math.ceil(timeoutMs / 1000) } : {}),
        }),
    }),
    ask_user: tool({
      description: "Ask the user a blocking question and wait for the answer.",
      inputSchema: z.object({
        questions: z.array(
          z.object({
            question: z.string(),
            header: z.string(),
            multiSelect: z.boolean(),
            options: z.array(
              z.object({
                label: z.string(),
                description: z.string().optional(),
              }),
            ),
          }),
        ),
      }),
    }),
  };
}

function firstQuestion(input: unknown): {
  header: string;
  prompt: string;
  multiple: boolean;
  options: Array<{ id: string; label: string; description?: string }>;
} {
  const record = recordOf(input);
  const questions = Array.isArray(record?.questions) ? record.questions : [];
  const first = recordOf(questions[0]);
  const prompt =
    typeof first?.question === "string" ? first.question : "Question";
  const header = typeof first?.header === "string" ? first.header : "Question";
  const entries = Array.isArray(first?.options) ? first.options : [];
  const options = entries.flatMap((entry) => {
    const option = recordOf(entry);
    if (typeof option?.label !== "string") return [];
    return [
      {
        id: option.label,
        label: option.label,
        ...(typeof option.description === "string"
          ? { description: option.description }
          : {}),
      },
    ];
  });
  return {
    header,
    prompt,
    multiple: first?.multiSelect === true,
    options,
  };
}

function mapUsage(
  usage: {
    inputTokens?: number;
    inputTokenDetails?: {
      noCacheTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
    };
    outputTokens?: number;
  },
  model: string | undefined,
) {
  const inputTokens = positiveNumber(usage.inputTokens);
  const outputTokens = positiveNumber(usage.outputTokens);
  if (inputTokens + outputTokens === 0) return undefined;
  const used =
    positiveNumber(usage.inputTokenDetails?.noCacheTokens) +
    positiveNumber(usage.inputTokenDetails?.cacheReadTokens) +
    positiveNumber(usage.inputTokenDetails?.cacheWriteTokens);
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    ...(model ? { model } : {}),
    ...(used > 0 ? { contextWindow: { used } } : {}),
  };
}

function accumulateUsage(
  current: MappedUsage | undefined,
  next: MappedUsage,
): MappedUsage {
  if (!current) return next;
  const inputTokens =
    positiveNumber(current.inputTokens) + positiveNumber(next.inputTokens);
  const outputTokens =
    positiveNumber(current.outputTokens) + positiveNumber(next.outputTokens);
  const totalTokens =
    positiveNumber(current.totalTokens) + positiveNumber(next.totalTokens);
  const contextUsed =
    positiveNumber(current.contextWindow?.used) +
    positiveNumber(next.contextWindow?.used);
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    ...((next.model ?? current.model)
      ? { model: next.model ?? current.model }
      : {}),
    ...(contextUsed > 0 ? { contextWindow: { used: contextUsed } } : {}),
  };
}

type MappedUsage = NonNullable<ReturnType<typeof mapUsage>>;

function effortProviderOptions(
  effort: "low" | "medium" | "high" | "xhigh" | "max",
) {
  const budgets = {
    low: 0,
    medium: 10_000,
    high: 32_000,
    xhigh: 48_000,
    max: 64_000,
  };
  return {
    anthropic:
      effort === "low"
        ? { thinking: { type: "disabled" } }
        : { thinking: { type: "enabled", budgetTokens: budgets[effort] } },
    openai: {
      reasoningEffort: effort === "xhigh" || effort === "max" ? "high" : effort,
    },
  };
}

function modelIdOf(model: LanguageModel): string | undefined {
  return typeof model === "object" && model !== null && "modelId" in model
    ? String(model.modelId)
    : typeof model === "string"
      ? model
      : undefined;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return Object.fromEntries(Object.entries(value));
}

function positiveNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cancelledResponse(
  request: AgentRuntimeRequest,
): AgentRuntimeRequestResponse {
  if (request.kind === "approval") {
    return { kind: "approval", decision: "denied" };
  }
  if (request.kind === "question") {
    return { kind: "question", answers: [] };
  }
  return { kind: "elicitation", action: "cancel" };
}
