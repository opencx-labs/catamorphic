import crypto from "node:crypto";
import {
  createSdkMcpServer,
  type ElicitationRequest,
  type ElicitationResult,
  type HookCallback,
  type McpServerConfig,
  type Options,
  type PermissionResult,
  type Query,
  query,
  type SDKMessage,
  tool as sdkTool,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentApprovalRequest,
  AgentElicitationRequest,
  AgentMcpServerConfig,
  AgentPluginConfig,
  AgentQuestionRequest,
  AgentRuntimeDescriptor,
  AgentRuntimeEvent,
  AgentRuntimeProvider,
  AgentRuntimeRequest,
  AgentRuntimeRequestResponse,
  AgentRuntimeSession,
  AgentTask,
  AgentTaskStatus,
  AgentTurnHandle,
  ExtraTool,
  ExtraToolContext,
  McpServersSource,
  McpToolPolicyLayers,
  ResumeAgentRuntimeSession,
  StartAgentRuntimeSession,
  StartAgentTurn,
  SubscribeToAgentEvents,
  ToolPolicyAnnotations,
} from "@catamorphic/sandbox";
import {
  AgentRuntimeUnsupportedError,
  mergePolicyLayers,
  resolveMcpServers,
  resolveToolPermissionAcross,
} from "@catamorphic/sandbox";
import type { ZodRawShape } from "zod";

const SUBAGENT_TOOLS = new Set(["Task", "Agent"]);
const DEFAULT_POST_TURN_DRAIN_TIMEOUT_MS = 250;
const MAX_POST_TURN_DRAIN_TIMEOUT_MS = 5_000;

export interface ClaudeCodeToolPolicyRequest {
  sessionId: string;
  turnId: string;
  toolName: string;
  input: Record<string, unknown>;
  toolUseId: string;
}

export type ClaudeCodeToolPolicyDecision =
  | { decision: "allow" }
  | { decision: "deny"; reason?: string }
  | { decision: "ask"; title?: string; description?: string };

export interface ClaudeCodeAgentRuntimeOpts {
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  env?: Record<string, string>;
  executable?: "bun" | "deno" | "node";
  executableArgs?: string[];
  pathToClaudeCodeExecutable?: string;
  extraTools?: readonly ExtraTool[];
  disableBash?: boolean;
  mcpServers?: McpServersSource;
  mcpServersForSession?: (
    context: ExtraToolContext,
  ) => Record<string, AgentMcpServerConfig>;
  plugins?: readonly AgentPluginConfig[];
  mcpPolicies?:
    | Record<string, McpToolPolicyLayers>
    | (() => Record<string, McpToolPolicyLayers>);
  mcpToolAnnotations?:
    | Record<string, Record<string, ToolPolicyAnnotations>>
    | (() => Record<string, Record<string, ToolPolicyAnnotations>>);
  permissionMode?: "default" | "acceptEdits" | "plan" | "bypassPermissions";
  memory?: boolean;
  decideToolUse?: (
    request: ClaudeCodeToolPolicyRequest,
  ) => ClaudeCodeToolPolicyDecision | Promise<ClaudeCodeToolPolicyDecision>;
  postTurnDrainTimeoutMs?: number;
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
  response: Promise<AgentRuntimeRequestResponse>;
  resolve: (response: AgentRuntimeRequestResponse) => void;
}

interface ActiveTurn {
  turnId: string;
  abort: AbortController;
  terminal?: "completed" | "failed" | "interrupted" | "stopped";
  query?: Query;
  completedMessage: boolean;
  terminalToolUseIds: Set<string>;
  pendingToolFailures: Map<string, PendingToolFailure>;
}

interface PendingToolFailure {
  toolId: string;
  title?: string;
  error: string;
  providerPayloadRef: string;
}

interface QueryLease {
  turnId: string;
  released: Promise<void>;
  resolveReleased: () => void;
  isReleased: boolean;
  closeRequested: boolean;
  query?: Query;
  drainTimer?: ReturnType<typeof setTimeout>;
}

interface ClaudeRuntimeSessionState {
  session: AgentRuntimeSession;
  systemPrompt?: string;
  transcriptExists: boolean;
  events: AgentRuntimeEvent[];
  subscribers: Set<Subscriber>;
  requests: Map<string, PendingRequest>;
  tasks: Map<string, AgentTask>;
  taskIdsByToolUse: Map<string, string>;
  subagents: Set<string>;
  backgroundTasks: Set<string>;
  terminalTaskIds: Set<string>;
  terminalBackgroundToolUseIds: Set<string>;
  queryLease?: QueryLease;
  sequence: number;
  stopped: boolean;
  activeTurn?: ActiveTurn;
}

/** A long-lived normalized runtime over the complete Claude Agent SDK stream. */
export class ClaudeCodeAgentRuntime implements AgentRuntimeProvider {
  readonly name = "claude-code";
  private readonly sessions = new Map<string, ClaudeRuntimeSessionState>();

  constructor(private readonly opts: ClaudeCodeAgentRuntimeOpts = {}) {}

  async describe(
    _args: Record<string, never>,
  ): Promise<AgentRuntimeDescriptor> {
    return {
      id: this.name,
      displayName: "Claude Code",
      placement: "control_plane",
      resumability: true,
      operations: {
        resumeSession: true,
        retryTurn: false,
        interruptTurn: true,
      },
      capabilities: {
        approvals: true,
        questions: true,
        elicitations: true,
        plans: true,
        tasks: false,
        subagents: true,
        usage: true,
        dynamicTools: true,
      },
      models: this.opts.model ? [{ id: this.opts.model }] : [],
      efforts: ["low", "medium", "high", "xhigh", "max"],
      builtInTools: [],
      mcpGenerations: ["2024-11-05", "2025-03-26", "2025-06-18"],
      eventFidelity: "native",
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
      providerSessionId: crypto.randomUUID(),
      projectId: args.projectId,
      allocationId: args.allocationId,
      workingDirectory: args.workingDirectory,
    };
    const state = this.createState({
      session,
      systemPrompt: args.systemPrompt,
      transcriptExists: false,
    });
    this.sessions.set(args.sessionId, state);
    this.publish(state, {
      eventId: `claude-code:session:${args.sessionId}:started`,
      build: (base) => ({
        ...base,
        type: "session.started",
        session: { providerSessionId: session.providerSessionId },
      }),
    });
    return session;
  }

  async resumeSession(
    args: ResumeAgentRuntimeSession,
  ): Promise<AgentRuntimeSession> {
    const existing = this.sessions.get(args.sessionId);
    if (existing) {
      this.publish(existing, {
        eventId: `claude-code:session:${args.sessionId}:resumed:${existing.sequence + 1}`,
        build: (base) => ({
          ...base,
          type: "session.resumed",
          session: { providerSessionId: args.providerSessionId },
        }),
      });
      return existing.session;
    }
    const session: AgentRuntimeSession = {
      sessionId: args.sessionId,
      providerSessionId: args.providerSessionId,
      projectId: args.projectId,
      allocationId: args.allocationId,
      workingDirectory: args.workingDirectory,
    };
    const state = this.createState({
      session,
      transcriptExists: true,
      sequence: args.after.sequence,
    });
    this.sessions.set(args.sessionId, state);
    this.publish(state, {
      eventId: `claude-code:session:${args.sessionId}:resumed`,
      build: (base) => ({
        ...base,
        type: "session.resumed",
        session: { providerSessionId: args.providerSessionId },
      }),
    });
    return session;
  }

  async stopSession(args: { sessionId: string }): Promise<void> {
    const state = this.requireSession(args.sessionId);
    if (state.stopped) return;
    state.stopped = true;
    const turn = state.activeTurn;
    if (turn) {
      if (this.claimTerminal(state, turn, "stopped")) {
        this.flushToolFailures(state, turn);
      }
      turn.abort.abort("Session stopped");
      if (state.activeTurn === turn) state.activeTurn = undefined;
    }
    const lease = state.queryLease;
    if (lease) this.closeAndReleaseQueryLease(state, lease);
    this.publish(state, {
      eventId: `claude-code:session:${args.sessionId}:stopped`,
      turnId: null,
      build: (base) => ({ ...base, type: "session.stopped" }),
    });
    for (const subscriber of state.subscribers) {
      subscriber.closed = true;
      subscriber.wake?.();
    }
    state.tasks.clear();
    state.taskIdsByToolUse.clear();
    state.subagents.clear();
    state.backgroundTasks.clear();
    state.terminalTaskIds.clear();
    state.terminalBackgroundToolUseIds.clear();
  }

  async startTurn(args: StartAgentTurn): Promise<AgentTurnHandle> {
    const state = this.requireSession(args.sessionId);
    if (state.stopped) throw new Error("The agent runtime session is stopped");
    if (state.activeTurn) {
      throw new Error("A turn is already active for this session");
    }
    while (state.queryLease) {
      const lease = state.queryLease;
      await lease.released;
      if (state.stopped) {
        throw new Error("The agent runtime session is stopped");
      }
      if (state.activeTurn) {
        throw new Error("A turn is already active for this session");
      }
    }
    const turn: ActiveTurn = {
      turnId: crypto.randomUUID(),
      abort: new AbortController(),
      completedMessage: false,
      terminalToolUseIds: new Set(),
      pendingToolFailures: new Map(),
    };
    const lease = this.createQueryLease(turn.turnId);
    state.queryLease = lease;
    state.activeTurn = turn;
    this.publish(state, {
      eventId: `claude-code:turn:${turn.turnId}:started`,
      build: (base) => ({ ...base, type: "turn.started" }),
    });
    void this.runTurn({ state, turn, lease, args });
    return { sessionId: args.sessionId, turnId: turn.turnId };
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
    if (!this.claimTerminal(state, turn, "interrupted")) return;
    this.flushToolFailures(state, turn);
    turn.abort.abort(args.reason ?? "Interrupted by the host");
    this.publish(state, {
      eventId: `claude-code:turn:${turn.turnId}:interrupted`,
      turnId: turn.turnId,
      build: (base) => ({
        ...base,
        type: "turn.interrupted",
        ...(args.reason ? { reason: args.reason } : {}),
      }),
    });
    if (state.activeTurn === turn) state.activeTurn = undefined;
    let interrupt: ReturnType<Query["interrupt"]> | undefined;
    try {
      interrupt = turn.query?.interrupt();
    } catch (error) {
      this.publishDiagnostic(state, {
        id: `interrupt:${turn.turnId}`,
        level: "warn",
        message: errorMessage(error),
      });
    }
    const lease = state.queryLease;
    if (lease?.turnId === turn.turnId) {
      this.closeAndReleaseQueryLease(state, lease);
    }
    void interrupt?.catch((error) => {
      this.publishDiagnostic(state, {
        id: `interrupt:${turn.turnId}`,
        level: "warn",
        message: errorMessage(error),
      });
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
    state: ClaudeRuntimeSessionState,
    pending: PendingRequest,
    response: AgentRuntimeRequestResponse,
  ): void {
    if (!state.requests.delete(pending.request.requestId)) return;
    this.publish(state, {
      eventId: `claude-code:request:${pending.request.requestId}:resolved`,
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
    state: ClaudeRuntimeSessionState,
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

  async listTasks(_args: { sessionId: string }): Promise<readonly AgentTask[]> {
    throw new AgentRuntimeUnsupportedError({
      provider: this.name,
      operation: "listTasks",
    });
  }

  async controlTask(_args: {
    sessionId: string;
    taskId: string;
    action: "cancel" | "pause" | "resume";
  }): Promise<void> {
    throw new AgentRuntimeUnsupportedError({
      provider: this.name,
      operation: "controlTask",
    });
  }

  private createState(args: {
    session: AgentRuntimeSession;
    systemPrompt?: string;
    transcriptExists: boolean;
    sequence?: number;
  }): ClaudeRuntimeSessionState {
    return {
      session: args.session,
      systemPrompt: args.systemPrompt,
      transcriptExists: args.transcriptExists,
      events: [],
      subscribers: new Set(),
      requests: new Map(),
      tasks: new Map(),
      taskIdsByToolUse: new Map(),
      subagents: new Set(),
      backgroundTasks: new Set(),
      terminalTaskIds: new Set(),
      terminalBackgroundToolUseIds: new Set(),
      sequence: args.sequence ?? 0,
      stopped: false,
    };
  }

  private async runTurn(args: {
    state: ClaudeRuntimeSessionState;
    turn: ActiveTurn;
    lease: QueryLease;
    args: StartAgentTurn;
  }): Promise<void> {
    const { state, turn, lease } = args;
    const providerSessionId = state.session.providerSessionId;
    if (!providerSessionId) {
      this.failTurn(state, turn, "Claude Code session has no provider anchor");
      this.releaseQueryLease(state, lease);
      return;
    }
    let runtimeQuery: Query | undefined;
    try {
      const anchor = state.transcriptExists
        ? { resume: providerSessionId }
        : { sessionId: providerSessionId };
      runtimeQuery = query({
        prompt: args.args.message.content,
        options: {
          ...this.buildOptions(state, turn, args.args),
          ...anchor,
          abortController: turn.abort,
        },
      });
      lease.query = runtimeQuery;
      turn.query = runtimeQuery;
      if (lease.closeRequested || state.stopped) {
        this.closeAndReleaseQueryLease(state, lease);
        return;
      }
      let sawResult = false;
      for await (const message of runtimeQuery) {
        if (state.queryLease !== lease || state.stopped) {
          if (
            message.type === "system" &&
            message.subtype === "permission_denied"
          ) {
            this.publishLatePermissionDiagnostic(state, turn, message);
          }
          break;
        }
        if (turn.terminal) {
          this.mapPostTurnNativeMessage(state, turn, message);
          continue;
        }
        if (message.type === "system" && message.subtype === "init") {
          state.transcriptExists = true;
        }
        const terminal = this.mapNativeMessage(state, turn, message);
        if (terminal) {
          sawResult = true;
          if (state.activeTurn === turn) state.activeTurn = undefined;
          this.beginPostTurnDrain(state, lease);
        }
      }
      if (!turn.terminal && !sawResult) {
        this.failTurn(
          state,
          turn,
          "Claude Agent SDK stream ended without a result",
        );
      }
    } catch (error) {
      if (!turn.terminal) this.failTurn(state, turn, errorMessage(error));
    } finally {
      this.releaseQueryLease(state, lease);
      if (state.activeTurn === turn) state.activeTurn = undefined;
    }
  }

  private createQueryLease(turnId: string): QueryLease {
    let resolveReleased: (() => void) | undefined;
    const released = new Promise<void>((resolve) => {
      resolveReleased = resolve;
    });
    if (!resolveReleased) throw new Error("Failed to create query lease");
    return {
      turnId,
      released,
      resolveReleased,
      isReleased: false,
      closeRequested: false,
    };
  }

  private beginPostTurnDrain(
    state: ClaudeRuntimeSessionState,
    lease: QueryLease,
  ): void {
    if (lease.isReleased || lease.drainTimer) return;
    lease.drainTimer = setTimeout(() => {
      this.closeAndReleaseQueryLease(state, lease);
    }, this.postTurnDrainTimeoutMs());
  }

  private closeAndReleaseQueryLease(
    state: ClaudeRuntimeSessionState,
    lease: QueryLease,
  ): void {
    if (!lease.closeRequested) {
      lease.closeRequested = true;
      try {
        lease.query?.close();
      } catch (error) {
        this.publishDiagnostic(state, {
          id: `query-close:${lease.turnId}`,
          level: "warn",
          message: errorMessage(error),
          turnId: lease.turnId,
        });
      }
    }
    this.releaseQueryLease(state, lease);
  }

  private releaseQueryLease(
    state: ClaudeRuntimeSessionState,
    lease: QueryLease,
  ): void {
    if (lease.drainTimer) {
      clearTimeout(lease.drainTimer);
      lease.drainTimer = undefined;
    }
    if (lease.isReleased) return;
    lease.isReleased = true;
    if (state.queryLease === lease) state.queryLease = undefined;
    lease.resolveReleased();
  }

  private postTurnDrainTimeoutMs(): number {
    const configured = this.opts.postTurnDrainTimeoutMs;
    if (configured === undefined || !Number.isFinite(configured)) {
      return DEFAULT_POST_TURN_DRAIN_TIMEOUT_MS;
    }
    return Math.min(Math.max(0, configured), MAX_POST_TURN_DRAIN_TIMEOUT_MS);
  }

  private buildOptions(
    state: ClaudeRuntimeSessionState,
    turn: ActiveTurn,
    input: StartAgentTurn,
  ): Options {
    const toolContext: ExtraToolContext = {
      projectId: state.session.projectId,
      sessionId: state.session.sessionId,
      workingDirectory: state.session.workingDirectory,
    };
    const extraTools = this.opts.extraTools ?? [];
    const workspaceServer =
      extraTools.length > 0
        ? createSdkMcpServer({
            name: "workspace",
            version: "1.0.0",
            tools: extraTools.map((definition) =>
              sdkTool(
                definition.name,
                definition.description,
                definition.parameters as ZodRawShape,
                async (toolInput) => {
                  try {
                    const result = await definition.execute(
                      toolInput,
                      toolContext,
                    );
                    return {
                      content: [
                        { type: "text", text: stringifyResult(result) },
                      ],
                    };
                  } catch (error) {
                    return {
                      content: [{ type: "text", text: errorMessage(error) }],
                      isError: true,
                    };
                  }
                },
              ),
            ),
          })
        : undefined;
    const hostOwnsTodos = extraTools.some(
      (tool) => tool.name === "update_todo_list",
    );
    const disallowedTools = [
      ...(this.opts.disableBash && workspaceServer
        ? ["Bash", "PowerShell", "Monitor"]
        : []),
      ...(hostOwnsTodos ? ["TodoWrite"] : []),
    ];
    const externalServers = mapMcpServers({
      ...resolveMcpServers(this.opts.mcpServers),
      ...this.opts.mcpServersForSession?.(toolContext),
    });
    return {
      cwd: state.session.workingDirectory || undefined,
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        ...(state.systemPrompt ? { append: state.systemPrompt } : {}),
      },
      env: {
        ...process.env,
        ...(this.opts.memory === false
          ? { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" }
          : {}),
        ...this.opts.env,
      },
      executable: this.opts.executable,
      executableArgs: this.opts.executableArgs,
      pathToClaudeCodeExecutable: this.opts.pathToClaudeCodeExecutable,
      model: input.model ?? this.opts.model,
      effort: input.effort ?? this.opts.effort,
      permissionMode: this.opts.permissionMode ?? "acceptEdits",
      ...(workspaceServer || Object.keys(externalServers).length > 0
        ? {
            mcpServers: {
              ...externalServers,
              ...(workspaceServer ? { workspace: workspaceServer } : {}),
            },
          }
        : {}),
      ...(this.opts.plugins && this.opts.plugins.length > 0
        ? {
            plugins: this.opts.plugins.map((plugin) => ({
              type: "local" as const,
              path: plugin.path,
              skipMcpDiscovery: true,
            })),
          }
        : {}),
      ...(disallowedTools.length > 0 ? { disallowedTools } : {}),
      canUseTool: (toolName, toolInput, callback) =>
        this.canUseTool({
          state,
          turn,
          toolName,
          input: toolInput,
          toolUseId: callback.toolUseID,
          requestId: callback.requestId,
          signal: callback.signal,
        }),
      onElicitation: (request, callback) =>
        this.handleElicitation({
          state,
          turn,
          request,
          requestId: callback.requestId,
          signal: callback.signal,
        }),
      hooks: runtimeHooks((event) => this.publishHookEvent(state, event)),
      settingSources: ["user", "project", "local"],
      includePartialMessages: true,
    };
  }

  private async canUseTool(args: {
    state: ClaudeRuntimeSessionState;
    turn: ActiveTurn;
    toolName: string;
    input: Record<string, unknown>;
    toolUseId: string;
    requestId: string;
    signal: AbortSignal;
  }): Promise<PermissionResult> {
    if (args.toolName === "AskUserQuestion") {
      const request = questionRequestFromClaude(args);
      const response = await this.parkRequest(args.state, request, args.signal);
      if (response.kind !== "question") {
        return { behavior: "deny", message: "Question response kind mismatch" };
      }
      return {
        behavior: "allow",
        updatedInput: questionAnswerInput(args.input, response.answers),
      };
    }
    const decision = await this.toolDecision(args);
    if (decision.decision === "allow") return { behavior: "allow" };
    if (decision.decision === "deny") {
      return {
        behavior: "deny",
        message: decision.reason ?? `The host denied ${args.toolName}.`,
      };
    }
    const request: AgentApprovalRequest = {
      requestId: args.requestId,
      kind: "approval",
      status: "pending",
      sessionId: args.state.session.sessionId,
      turnId: args.turn.turnId,
      createdAt: new Date().toISOString(),
      origin: { kind: "tool", id: args.toolName },
      title: decision.title ?? `Allow ${args.toolName}?`,
      ...(decision.description ? { description: decision.description } : {}),
      approval: {
        action: args.toolName,
        details: JSON.stringify(args.input),
      },
    };
    const response = await this.parkRequest(args.state, request, args.signal);
    if (response.kind !== "approval") {
      return { behavior: "deny", message: "Approval response kind mismatch" };
    }
    return response.decision === "approved"
      ? { behavior: "allow" }
      : { behavior: "deny", message: `The host denied ${args.toolName}.` };
  }

  private async toolDecision(args: {
    state: ClaudeRuntimeSessionState;
    turn: ActiveTurn;
    toolName: string;
    input: Record<string, unknown>;
    toolUseId: string;
  }): Promise<ClaudeCodeToolPolicyDecision> {
    if (this.opts.decideToolUse) {
      return this.opts.decideToolUse({
        sessionId: args.state.session.sessionId,
        turnId: args.turn.turnId,
        toolName: args.toolName,
        input: args.input,
        toolUseId: args.toolUseId,
      });
    }
    const parsed = parseMcpToolName(args.toolName);
    if (!parsed) return { decision: "ask" };
    const source = this.opts.mcpPolicies;
    const policies = typeof source === "function" ? source() : source;
    if (!policies?.[parsed.server]) return { decision: "allow" };
    const annotationSource = this.opts.mcpToolAnnotations;
    const annotations =
      typeof annotationSource === "function"
        ? annotationSource()
        : annotationSource;
    const decision = resolveToolPermissionAcross(
      mergePolicyLayers(policies, undefined)?.[parsed.server],
      parsed.tool,
      annotations?.[parsed.server]?.[parsed.tool],
    );
    if (decision === "allow") return { decision: "allow" };
    if (decision === "deny") {
      return {
        decision: "deny",
        reason: `The tool "${parsed.tool}" on ${parsed.server} is turned off in this connection's permissions.`,
      };
    }
    return { decision: "ask", title: `Allow ${parsed.tool}?` };
  }

  private async handleElicitation(args: {
    state: ClaudeRuntimeSessionState;
    turn: ActiveTurn;
    request: ElicitationRequest;
    requestId: string;
    signal: AbortSignal;
  }): Promise<ElicitationResult> {
    const request: AgentElicitationRequest = {
      requestId: args.requestId,
      kind: "elicitation",
      status: "pending",
      sessionId: args.state.session.sessionId,
      turnId: args.turn.turnId,
      createdAt: new Date().toISOString(),
      origin: {
        kind: "mcp",
        id: args.request.serverName,
        ...(args.request.displayName
          ? { displayName: args.request.displayName }
          : {}),
      },
      title: args.request.title ?? args.request.message,
      ...(args.request.description
        ? { description: args.request.description }
        : {}),
      elicitation: {
        server: args.request.serverName,
        method: args.request.mode ?? "form",
        ...(args.request.requestedSchema
          ? { schema: args.request.requestedSchema }
          : {}),
      },
    };
    const response = await this.parkRequest(args.state, request, args.signal);
    if (response.kind !== "elicitation") return { action: "cancel" };
    const content = elicitationContent(response.content);
    return {
      action: response.action,
      ...(response.action === "accept" && content ? { content } : {}),
    };
  }

  private parkRequest(
    state: ClaudeRuntimeSessionState,
    request: AgentRuntimeRequest,
    signal?: AbortSignal,
  ): Promise<AgentRuntimeRequestResponse> {
    const existing = state.requests.get(request.requestId);
    if (existing) return existing.response;
    let resolveResponse:
      | ((response: AgentRuntimeRequestResponse) => void)
      | undefined;
    const response = new Promise<AgentRuntimeRequestResponse>((resolve) => {
      resolveResponse = resolve;
    });
    if (!resolveResponse) throw new Error("Failed to create request resolver");
    const pending = { request, response, resolve: resolveResponse };
    state.requests.set(request.requestId, pending);
    this.publish(state, {
      eventId: `claude-code:request:${request.requestId}:created`,
      turnId: request.turnId,
      build: (base) => ({ ...base, type: "request.created", request }),
    });
    if (signal) {
      const cancel = () => {
        this.resolvePendingRequest(state, pending, cancelledResponse(request));
      };
      if (signal.aborted) cancel();
      else signal.addEventListener("abort", cancel, { once: true });
    }
    return response;
  }

  private mapNativeMessage(
    state: ClaudeRuntimeSessionState,
    turn: ActiveTurn,
    message: SDKMessage,
  ): boolean {
    if (turn.terminal) return true;
    if (message.type === "stream_event") {
      if (
        message.event.type === "content_block_delta" &&
        message.event.delta.type === "text_delta" &&
        !message.parent_tool_use_id
      ) {
        const delta = message.event.delta.text;
        this.publish(state, {
          eventId: `claude-code:${message.uuid}:text-delta`,
          providerPayloadRef: message.uuid,
          build: (base) => ({
            ...base,
            type: "message.delta",
            message: { role: "assistant", delta },
          }),
        });
      }
      return false;
    }
    if (message.type === "assistant") {
      this.mapAssistantMessage(state, turn, message);
      return false;
    }
    if (message.type === "user") {
      this.mapUserMessage(state, turn, message);
      return false;
    }
    if (message.type === "tool_progress") {
      this.publishTool(
        state,
        "tool.progressed",
        {
          toolId: message.tool_use_id,
          title: message.tool_name,
          progress: {
            message: `${message.elapsed_time_seconds}s elapsed`,
          },
        },
        message.uuid,
      );
      if (message.task_id) {
        const task = state.tasks.get(message.task_id);
        if (task) this.publishTask(state, "task.updated", task, message.uuid);
      }
      return false;
    }
    if (message.type === "result") {
      const resultTerminal =
        message.subtype === "success" ? "completed" : "failed";
      if (!this.claimTerminal(state, turn, resultTerminal)) return true;
      for (const denial of message.permission_denials) {
        this.rememberToolFailure(turn, {
          toolId: denial.tool_use_id,
          title: denial.tool_name,
          error: "Permission denied",
          providerPayloadRef: message.uuid,
        });
      }
      this.flushToolFailures(state, turn);
      const usage = usageFromResult(message);
      if (usage) {
        this.publish(state, {
          eventId: `claude-code:${message.uuid}:usage`,
          providerPayloadRef: message.uuid,
          build: (base) => ({ ...base, type: "usage.updated", usage }),
        });
      }
      if (message.subtype !== "success") {
        const reason =
          message.errors.filter(Boolean).join("\n") || message.subtype;
        this.publishTurnFailure(state, turn, reason, message.uuid);
        return true;
      }
      if (!turn.completedMessage && message.result) {
        this.publish(state, {
          eventId: `claude-code:${message.uuid}:result-message`,
          providerPayloadRef: message.uuid,
          build: (base) => ({
            ...base,
            type: "message.completed",
            message: { role: "assistant", content: message.result },
          }),
        });
        turn.completedMessage = true;
      }
      this.publish(state, {
        eventId: `claude-code:turn:${turn.turnId}:completed`,
        turnId: turn.turnId,
        providerPayloadRef: message.uuid,
        build: (base) => ({ ...base, type: "turn.completed" }),
      });
      return true;
    }
    if (message.type === "system") {
      this.mapSystemMessage(state, turn, message);
      return false;
    }
    this.publishDiagnostic(state, {
      id: nativeId(message),
      providerPayloadRef: nativeId(message),
      level: "debug",
      message: `Claude SDK event: ${message.type}`,
    });
    return false;
  }

  private mapPostTurnNativeMessage(
    state: ClaudeRuntimeSessionState,
    turn: ActiveTurn,
    message: SDKMessage,
  ): void {
    if (message.type !== "system") return;
    if (message.subtype === "task_notification") {
      this.mapTaskNotification(state, turn, message);
      return;
    }
    if (message.subtype === "permission_denied") {
      this.publishLatePermissionDiagnostic(state, turn, message);
    }
  }

  private publishLatePermissionDiagnostic(
    state: ClaudeRuntimeSessionState,
    turn: ActiveTurn,
    message: Extract<
      SDKMessage,
      { type: "system"; subtype: "permission_denied" }
    >,
  ): void {
    this.publishDiagnostic(state, {
      id: `${message.uuid}:late-permission-denial`,
      providerPayloadRef: message.uuid,
      level: "warn",
      message: `Claude permission denial arrived after the turn was ${turn.terminal}: ${message.message}`,
      turnId: turn.turnId,
    });
  }

  private mapAssistantMessage(
    state: ClaudeRuntimeSessionState,
    turn: ActiveTurn,
    message: Extract<SDKMessage, { type: "assistant" }>,
  ): void {
    const text = message.parent_tool_use_id
      ? ""
      : message.message.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("\n");
    if (text.length > 0) {
      this.publish(state, {
        eventId: `claude-code:${message.uuid}:assistant-message`,
        providerPayloadRef: message.uuid,
        build: (base) => ({
          ...base,
          type: "message.completed",
          message: {
            messageId: message.uuid,
            role: "assistant",
            content: text,
          },
        }),
      });
      turn.completedMessage = true;
    }
    for (const block of message.message.content) {
      if (block.type !== "tool_use") continue;
      const input = recordOf(block.input) ?? {};
      this.publishTool(
        state,
        "tool.started",
        {
          toolId: block.id,
          title: block.name,
        },
        message.uuid,
      );
      if (block.name === "TodoWrite") {
        const plan = planFromInput(block.id, input);
        this.publish(state, {
          eventId: `claude-code:${message.uuid}:plan:${block.id}`,
          providerPayloadRef: message.uuid,
          build: (base) => ({ ...base, type: "plan.replaced", plan }),
        });
        continue;
      }
      if (SUBAGENT_TOOLS.has(block.name)) {
        state.subagents.add(block.id);
        this.publish(state, {
          eventId: `claude-code:${message.uuid}:subagent:${block.id}:started`,
          providerPayloadRef: message.uuid,
          build: (base) => ({
            ...base,
            type: "subagent.started",
            subagent: {
              subagentId: block.id,
              title:
                typeof input.description === "string"
                  ? input.description
                  : block.name,
              status: "running",
            },
          }),
        });
      }
    }
  }

  private mapUserMessage(
    state: ClaudeRuntimeSessionState,
    turn: ActiveTurn,
    message: Extract<SDKMessage, { type: "user" }>,
  ): void {
    if (typeof message.message.content === "string") return;
    for (const block of message.message.content) {
      if (block.type !== "tool_result") continue;
      const failed = block.is_error === true;
      const taskId = state.taskIdsByToolUse.get(block.tool_use_id);
      const current = taskId ? state.tasks.get(taskId) : undefined;
      const trackedAgentTool =
        state.subagents.has(block.tool_use_id) ||
        state.taskIdsByToolUse.has(block.tool_use_id);
      if (
        trackedAgentTool &&
        isBackgroundAgentAcknowledgement(message.tool_use_result)
      ) {
        const progress = stringifyResult(block.content);
        this.publishTool(
          state,
          "tool.progressed",
          {
            toolId: block.tool_use_id,
            progress: { message: progress },
          },
          nativeId(message),
        );
        if (current) {
          this.publishTask(state, "task.updated", current, nativeId(message));
        }
        if (state.subagents.has(block.tool_use_id)) {
          this.publish(state, {
            eventId: `claude-code:${nativeId(message)}:subagent:${block.tool_use_id}:updated`,
            providerPayloadRef: nativeId(message),
            build: (base) => ({
              ...base,
              type: "subagent.updated",
              subagent: {
                subagentId: block.tool_use_id,
                title: current?.title ?? "Subagent",
                status: "running",
              },
            }),
          });
        }
        continue;
      }
      const failure = failed ? stringifyResult(block.content) : undefined;
      if (failure && isPermissionDenial(failure)) {
        this.rememberToolFailure(turn, {
          toolId: block.tool_use_id,
          error: failure,
          providerPayloadRef: nativeId(message),
        });
      } else {
        this.publishNativeToolTerminal(
          state,
          turn,
          failed ? "tool.failed" : "tool.completed",
          {
            toolId: block.tool_use_id,
            ...(failure ? { error: failure } : {}),
          },
          nativeId(message),
        );
      }
      if (taskId && current) {
        const task: AgentTask = {
          ...current,
          status: failed ? "failed" : "completed",
        };
        this.publishTrackedTaskTerminal(state, turn, task, nativeId(message), {
          toolUseId: block.tool_use_id,
          publishToolTerminal: false,
        });
      } else if (state.subagents.delete(block.tool_use_id)) {
        this.publish(state, {
          eventId: `claude-code:${nativeId(message)}:subagent:${block.tool_use_id}:${failed ? "failed" : "completed"}`,
          providerPayloadRef: nativeId(message),
          build: (base) => ({
            ...base,
            type: failed ? "subagent.failed" : "subagent.completed",
            subagent: {
              subagentId: block.tool_use_id,
              title: "Subagent",
              status: failed ? "failed" : "completed",
            },
          }),
        });
      }
    }
  }

  private mapTaskNotification(
    state: ClaudeRuntimeSessionState,
    turn: ActiveTurn,
    message: Extract<
      SDKMessage,
      { type: "system"; subtype: "task_notification" }
    >,
  ): void {
    const current = state.tasks.get(message.task_id);
    const status = mapNotificationStatus(message.status);
    if (state.terminalTaskIds.has(message.task_id)) {
      this.cleanupTaskTracking(state, message.task_id, message.tool_use_id);
      if (current && current.status !== status) {
        this.publishDiagnostic(state, {
          id: `${message.uuid}:conflicting-task-terminal`,
          providerPayloadRef: message.uuid,
          level: "warn",
          message: `Ignored conflicting task notification for ${message.task_id}: kept ${current.status}, received ${status}`,
          turnId: current.turnId,
        });
      }
      return;
    }
    const task: AgentTask = {
      taskId: message.task_id,
      sessionId: state.session.sessionId,
      turnId: current?.turnId ?? turn.turnId,
      title: current?.title ?? message.summary,
      description: message.summary,
      status,
    };
    this.publishTrackedTaskTerminal(state, turn, task, message.uuid, {
      ...(message.tool_use_id ? { toolUseId: message.tool_use_id } : {}),
    });
  }

  private mapSystemMessage(
    state: ClaudeRuntimeSessionState,
    turn: ActiveTurn,
    message: Extract<SDKMessage, { type: "system" }>,
  ): void {
    switch (message.subtype) {
      case "init":
        this.publishDiagnostic(state, {
          id: message.uuid,
          providerPayloadRef: message.uuid,
          level: "info",
          message: `Claude Code ${message.claude_code_version} initialized with ${message.model}`,
        });
        return;
      case "task_started": {
        const task: AgentTask = {
          taskId: message.task_id,
          sessionId: state.session.sessionId,
          turnId: turn.turnId,
          title: message.description,
          ...(message.prompt ? { description: message.prompt } : {}),
          status: "running",
        };
        state.tasks.set(task.taskId, task);
        if (message.tool_use_id) {
          state.taskIdsByToolUse.set(message.tool_use_id, task.taskId);
        }
        this.publishTask(state, "task.started", task, message.uuid);
        if (message.subagent_type || message.tool_use_id) {
          const subagentId = message.tool_use_id ?? message.task_id;
          const type = state.subagents.has(subagentId)
            ? "subagent.updated"
            : "subagent.started";
          state.subagents.add(subagentId);
          this.publish(state, {
            eventId: `claude-code:${message.uuid}:${type}:${subagentId}`,
            providerPayloadRef: message.uuid,
            build: (base) => ({
              ...base,
              type,
              subagent: {
                subagentId,
                title: message.description,
                status: "running",
              },
            }),
          });
        }
        return;
      }
      case "task_progress": {
        const current = state.tasks.get(message.task_id);
        const task: AgentTask = {
          taskId: message.task_id,
          sessionId: state.session.sessionId,
          turnId: turn.turnId,
          title: message.description,
          ...(message.summary ? { description: message.summary } : {}),
          status: current?.status ?? "running",
        };
        state.tasks.set(task.taskId, task);
        this.publishTask(state, "task.updated", task, message.uuid);
        const subagentId = message.tool_use_id ?? message.task_id;
        if (state.subagents.has(subagentId)) {
          this.publish(state, {
            eventId: `claude-code:${message.uuid}:subagent:${subagentId}:updated`,
            providerPayloadRef: message.uuid,
            build: (base) => ({
              ...base,
              type: "subagent.updated",
              subagent: {
                subagentId,
                title: message.summary ?? message.description,
                status: "running",
              },
            }),
          });
        }
        return;
      }
      case "task_updated": {
        const current = state.tasks.get(message.task_id);
        if (!current) return;
        const status = mapTaskStatus(message.patch.status) ?? current.status;
        if (
          isTerminalTaskStatus(status) &&
          state.terminalTaskIds.has(message.task_id)
        ) {
          this.cleanupTaskTracking(state, message.task_id);
          return;
        }
        const task: AgentTask = {
          ...current,
          ...(message.patch.description
            ? { title: message.patch.description }
            : {}),
          ...(message.patch.error ? { description: message.patch.error } : {}),
          status,
        };
        if (isTerminalTaskStatus(task.status)) {
          this.publishTrackedTaskTerminal(state, turn, task, message.uuid);
        } else {
          state.tasks.set(task.taskId, task);
          this.publishTask(state, "task.updated", task, message.uuid);
        }
        return;
      }
      case "task_notification": {
        this.mapTaskNotification(state, turn, message);
        return;
      }
      case "background_tasks_changed":
        state.backgroundTasks = new Set(
          message.tasks.map((task) => task.task_id),
        );
        for (const nativeTask of message.tasks) {
          const current = state.tasks.get(nativeTask.task_id);
          const task: AgentTask = {
            taskId: nativeTask.task_id,
            sessionId: state.session.sessionId,
            turnId: turn.turnId,
            title: nativeTask.description,
            status: current?.status ?? "running",
          };
          state.tasks.set(task.taskId, task);
          this.publishTask(state, "task.updated", task, message.uuid);
        }
        return;
      case "files_persisted":
        if (message.files.length > 0) {
          this.publish(state, {
            eventId: `claude-code:${message.uuid}:workspace:persisted`,
            providerPayloadRef: message.uuid,
            build: (base) => ({
              ...base,
              type: "workspace.changed",
              changes: message.files.map((file) => ({
                path: file.filename,
                kind: "modified" as const,
              })),
            }),
          });
        }
        if (message.failed.length > 0) {
          this.publishDiagnostic(state, {
            id: `${message.uuid}:files-persist-failed`,
            providerPayloadRef: message.uuid,
            level: "warn",
            message: message.failed
              .map((file) => `${file.filename}: ${file.error}`)
              .join("\n"),
          });
        }
        return;
      case "hook_started":
        this.publishTool(
          state,
          "tool.requested",
          {
            toolId: message.hook_id,
            title: `${message.hook_event}: ${message.hook_name}`,
          },
          message.uuid,
        );
        return;
      case "hook_progress":
        this.publishTool(
          state,
          "tool.progressed",
          {
            toolId: message.hook_id,
            title: `${message.hook_event}: ${message.hook_name}`,
            progress: {
              message: message.output || message.stdout || message.stderr,
            },
          },
          message.uuid,
        );
        return;
      case "hook_response":
        this.publishTool(
          state,
          message.outcome === "success"
            ? "tool.completed"
            : message.outcome === "cancelled"
              ? "tool.cancelled"
              : "tool.failed",
          {
            toolId: message.hook_id,
            title: `${message.hook_event}: ${message.hook_name}`,
            ...(message.outcome === "error"
              ? { error: message.stderr || message.output }
              : {}),
          },
          message.uuid,
        );
        return;
      case "permission_denied":
        this.rememberToolFailure(turn, {
          toolId: message.tool_use_id,
          title: message.tool_name,
          error: message.message,
          providerPayloadRef: message.uuid,
        });
        return;
      case "api_retry":
        this.publishDiagnostic(state, {
          id: message.uuid,
          providerPayloadRef: message.uuid,
          level: "warn",
          message: `Claude API retry ${message.attempt}/${message.max_retries}: ${message.error}`,
        });
        return;
      case "informational":
        this.publishDiagnostic(state, {
          id: message.uuid,
          providerPayloadRef: message.uuid,
          level: message.level === "warning" ? "warn" : "info",
          message: message.content,
        });
        return;
      default:
        this.publishDiagnostic(state, {
          id: message.uuid,
          providerPayloadRef: message.uuid,
          level: "debug",
          message: `Claude SDK system event: ${message.subtype}`,
        });
    }
  }

  private publishHookEvent(
    state: ClaudeRuntimeSessionState,
    event: RuntimeHookEvent,
  ): void {
    if (event.kind === "process.started") {
      this.publish(state, {
        eventId: `claude-code:hook:process:${event.processId}:started`,
        build: (base) => ({
          ...base,
          type: "process.started",
          process: {
            processId: event.processId,
            status: "running",
            ...(event.command ? { command: event.command } : {}),
          },
        }),
      });
      return;
    }
    this.publish(state, {
      eventId: `claude-code:hook:process:${event.processId}:completed`,
      build: (base) => ({
        ...base,
        type: "process.completed",
        process: { processId: event.processId, status: "completed" },
      }),
    });
  }

  private publishTool(
    state: ClaudeRuntimeSessionState,
    type:
      | "tool.requested"
      | "tool.started"
      | "tool.progressed"
      | "tool.completed"
      | "tool.failed"
      | "tool.cancelled",
    toolEvent: {
      toolId: string;
      title?: string;
      progress?: { message?: string };
      error?: string;
    },
    providerPayloadRef?: string,
    turnId?: string,
  ): void {
    this.publish(state, {
      eventId: `claude-code:${providerPayloadRef ?? crypto.randomUUID()}:${type}:${toolEvent.toolId}`,
      ...(turnId ? { turnId } : {}),
      ...(providerPayloadRef ? { providerPayloadRef } : {}),
      build: (base) => ({ ...base, type, tool: toolEvent }),
    });
  }

  private publishNativeToolTerminal(
    state: ClaudeRuntimeSessionState,
    turn: ActiveTurn,
    type: "tool.completed" | "tool.failed" | "tool.cancelled",
    toolEvent: { toolId: string; title?: string; error?: string },
    providerPayloadRef: string,
  ): boolean {
    if (turn.terminalToolUseIds.has(toolEvent.toolId)) return false;
    turn.terminalToolUseIds.add(toolEvent.toolId);
    turn.pendingToolFailures.delete(toolEvent.toolId);
    this.publishTool(state, type, toolEvent, providerPayloadRef);
    return true;
  }

  private publishBackgroundToolTerminal(
    state: ClaudeRuntimeSessionState,
    turn: ActiveTurn,
    type: "tool.completed" | "tool.failed" | "tool.cancelled",
    toolEvent: { toolId: string; title?: string; error?: string },
    providerPayloadRef: string,
    turnId?: string,
  ): boolean {
    if (state.terminalBackgroundToolUseIds.has(toolEvent.toolId)) return false;
    state.terminalBackgroundToolUseIds.add(toolEvent.toolId);
    if (turn.terminalToolUseIds.has(toolEvent.toolId)) return false;
    turn.terminalToolUseIds.add(toolEvent.toolId);
    turn.pendingToolFailures.delete(toolEvent.toolId);
    this.publishTool(state, type, toolEvent, providerPayloadRef, turnId);
    return true;
  }

  private rememberToolFailure(
    turn: ActiveTurn,
    failure: PendingToolFailure,
  ): void {
    if (turn.terminalToolUseIds.has(failure.toolId)) return;
    const current = turn.pendingToolFailures.get(failure.toolId);
    if (
      !current ||
      usefulFailureReasonScore(failure.error) >
        usefulFailureReasonScore(current.error)
    ) {
      turn.pendingToolFailures.set(failure.toolId, failure);
      return;
    }
    if (!current.title && failure.title) {
      turn.pendingToolFailures.set(failure.toolId, {
        ...current,
        title: failure.title,
      });
    }
  }

  private flushToolFailures(
    state: ClaudeRuntimeSessionState,
    turn: ActiveTurn,
  ): void {
    for (const failure of [...turn.pendingToolFailures.values()]) {
      this.publishNativeToolTerminal(
        state,
        turn,
        "tool.failed",
        {
          toolId: failure.toolId,
          ...(failure.title ? { title: failure.title } : {}),
          error: failure.error,
        },
        failure.providerPayloadRef,
      );
    }
  }

  private publishTrackedTaskTerminal(
    state: ClaudeRuntimeSessionState,
    turn: ActiveTurn,
    task: AgentTask,
    providerPayloadRef: string,
    options: { toolUseId?: string; publishToolTerminal?: boolean } = {},
  ): void {
    if (!isTerminalTaskStatus(task.status)) return;
    if (state.terminalTaskIds.has(task.taskId)) {
      this.cleanupTaskTracking(state, task.taskId, options.toolUseId);
      return;
    }
    const toolUseId = this.takeTaskToolUseId(
      state,
      task.taskId,
      options.toolUseId,
    );
    state.terminalTaskIds.add(task.taskId);
    state.tasks.set(task.taskId, task);
    if (toolUseId && options.publishToolTerminal !== false) {
      this.publishBackgroundToolTerminal(
        state,
        turn,
        toolTerminalEventType(task.status),
        {
          toolId: toolUseId,
          ...(task.status === "failed"
            ? { error: task.description ?? task.title }
            : {}),
        },
        providerPayloadRef,
        task.turnId,
      );
    } else if (toolUseId) {
      state.terminalBackgroundToolUseIds.add(toolUseId);
    }
    this.publishTask(
      state,
      taskTerminalEventType(task.status),
      task,
      providerPayloadRef,
    );
    const subagentId =
      toolUseId ?? (state.subagents.has(task.taskId) ? task.taskId : undefined);
    if (subagentId && state.subagents.delete(subagentId)) {
      this.publish(state, {
        eventId: `claude-code:${providerPayloadRef}:subagent:${subagentId}:${task.status}`,
        turnId: task.turnId ?? null,
        providerPayloadRef,
        build: (base) => ({
          ...base,
          type:
            task.status === "completed"
              ? "subagent.completed"
              : "subagent.failed",
          subagent: {
            subagentId,
            title:
              task.status === "failed"
                ? (task.description ?? task.title)
                : task.title,
            status: task.status,
          },
        }),
      });
    }
  }

  private takeTaskToolUseId(
    state: ClaudeRuntimeSessionState,
    taskId: string,
    explicitToolUseId?: string,
  ): string | undefined {
    let toolUseId = explicitToolUseId;
    for (const [
      candidateToolUseId,
      candidateTaskId,
    ] of state.taskIdsByToolUse) {
      if (candidateTaskId !== taskId) continue;
      toolUseId ??= candidateToolUseId;
      state.taskIdsByToolUse.delete(candidateToolUseId);
    }
    if (explicitToolUseId) state.taskIdsByToolUse.delete(explicitToolUseId);
    state.backgroundTasks.delete(taskId);
    return toolUseId;
  }

  private cleanupTaskTracking(
    state: ClaudeRuntimeSessionState,
    taskId: string,
    explicitToolUseId?: string,
  ): void {
    const toolUseId = this.takeTaskToolUseId(state, taskId, explicitToolUseId);
    if (toolUseId) state.subagents.delete(toolUseId);
    else state.subagents.delete(taskId);
  }

  private publishTask(
    state: ClaudeRuntimeSessionState,
    type:
      | "task.started"
      | "task.updated"
      | "task.completed"
      | "task.failed"
      | "task.cancelled",
    task: AgentTask,
    providerPayloadRef: string,
  ): void {
    this.publish(state, {
      eventId: `claude-code:${providerPayloadRef}:${type}:${task.taskId}`,
      turnId: task.turnId ?? null,
      providerPayloadRef,
      build: (base) => ({ ...base, type, task }),
    });
  }

  private publishDiagnostic(
    state: ClaudeRuntimeSessionState,
    args: {
      id: string;
      providerPayloadRef?: string;
      level: "debug" | "info" | "warn";
      message: string;
      turnId?: string;
    },
  ): void {
    this.publish(state, {
      eventId: `claude-code:${args.id}:diagnostic`,
      ...(args.turnId ? { turnId: args.turnId } : {}),
      ...(args.providerPayloadRef
        ? { providerPayloadRef: args.providerPayloadRef }
        : {}),
      build: (base) => ({
        ...base,
        type: "diagnostic",
        diagnostic: { level: args.level, message: args.message },
      }),
    });
  }

  private failTurn(
    state: ClaudeRuntimeSessionState,
    turn: ActiveTurn,
    reason: string,
    providerPayloadRef?: string,
  ): void {
    if (!this.claimTerminal(state, turn, "failed")) return;
    this.flushToolFailures(state, turn);
    this.publishTurnFailure(state, turn, reason, providerPayloadRef);
  }

  private publishTurnFailure(
    state: ClaudeRuntimeSessionState,
    turn: ActiveTurn,
    reason: string,
    providerPayloadRef?: string,
  ): void {
    this.publish(state, {
      eventId: `claude-code:${providerPayloadRef ?? turn.turnId}:error`,
      turnId: turn.turnId,
      ...(providerPayloadRef ? { providerPayloadRef } : {}),
      build: (base) => ({
        ...base,
        type: "error",
        error: { message: reason, fatal: false },
      }),
    });
    this.publish(state, {
      eventId: `claude-code:${providerPayloadRef ?? turn.turnId}:failed`,
      turnId: turn.turnId,
      ...(providerPayloadRef ? { providerPayloadRef } : {}),
      build: (base) => ({ ...base, type: "turn.failed", reason }),
    });
  }

  private claimTerminal(
    state: ClaudeRuntimeSessionState,
    turn: ActiveTurn,
    terminal: NonNullable<ActiveTurn["terminal"]>,
  ): boolean {
    if (turn.terminal) return false;
    turn.terminal = terminal;
    this.cancelRequestsForTurn(state, turn.turnId);
    return true;
  }

  private publish(
    state: ClaudeRuntimeSessionState,
    args: {
      eventId: string;
      turnId?: string | null;
      providerPayloadRef?: string;
      build: (base: EventBase) => AgentRuntimeEvent;
    },
  ): void {
    const sequence = state.sequence + 1;
    state.sequence = sequence;
    const turnId =
      args.turnId === null
        ? undefined
        : (args.turnId ?? state.activeTurn?.turnId);
    const base: EventBase = {
      eventId: args.eventId,
      sequence,
      occurredAt: new Date().toISOString(),
      sessionId: state.session.sessionId,
      ...(turnId ? { turnId } : {}),
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

  private requireSession(sessionId: string): ClaudeRuntimeSessionState {
    const state = this.sessions.get(sessionId);
    if (!state)
      throw new Error(`Agent runtime session not found: ${sessionId}`);
    return state;
  }
}

function questionRequestFromClaude(args: {
  state: ClaudeRuntimeSessionState;
  turn: ActiveTurn;
  input: Record<string, unknown>;
  requestId: string;
}): AgentQuestionRequest {
  const questions = Array.isArray(args.input.questions)
    ? args.input.questions
    : [];
  const first = recordOf(questions[0]);
  const prompt =
    typeof first?.question === "string" ? first.question : "Question";
  const options = (Array.isArray(first?.options) ? first.options : []).flatMap(
    (entry) => {
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
    },
  );
  return {
    requestId: args.requestId,
    kind: "question",
    status: "pending",
    sessionId: args.state.session.sessionId,
    turnId: args.turn.turnId,
    createdAt: new Date().toISOString(),
    origin: { kind: "tool", id: "AskUserQuestion" },
    title: typeof first?.header === "string" ? first.header : "Question",
    question: {
      prompt,
      options,
      multiple: first?.multiSelect === true,
    },
  };
}

function questionAnswerInput(
  input: Record<string, unknown>,
  answers: readonly string[],
): Record<string, unknown> {
  const questions = Array.isArray(input.questions) ? input.questions : [];
  const mapped: Record<string, string> = {};
  for (const [index, entry] of questions.entries()) {
    const question = recordOf(entry)?.question;
    const answer = answers[index];
    if (typeof question === "string" && answer) mapped[question] = answer;
  }
  return { ...input, answers: mapped };
}

function cancelledResponse(
  request: AgentRuntimeRequest,
): AgentRuntimeRequestResponse {
  if (request.kind === "approval")
    return { kind: "approval", decision: "denied" };
  if (request.kind === "question") return { kind: "question", answers: [] };
  return { kind: "elicitation", action: "cancel" };
}

function planFromInput(planId: string, input: Record<string, unknown>) {
  const todos = Array.isArray(input.todos) ? input.todos : [];
  return {
    planId,
    items: todos.flatMap((entry, index) => {
      const todo = recordOf(entry);
      if (typeof todo?.content !== "string") return [];
      const status: "pending" | "in_progress" | "completed" | "cancelled" =
        todo.status === "in_progress" ||
        todo.status === "completed" ||
        todo.status === "cancelled"
          ? todo.status
          : "pending";
      return [{ id: `${planId}:${index}`, title: todo.content, status }];
    }),
  };
}

function usageFromResult(message: Extract<SDKMessage, { type: "result" }>) {
  let model: string | undefined;
  let contextLimit: number | undefined;
  let contextUsed = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let dominant = -1;
  for (const [name, usage] of Object.entries(message.modelUsage)) {
    const input =
      positiveNumber(usage.inputTokens) +
      positiveNumber(usage.cacheReadInputTokens) +
      positiveNumber(usage.cacheCreationInputTokens);
    const output = positiveNumber(usage.outputTokens);
    inputTokens += input;
    outputTokens += output;
    if (input + output > dominant) {
      dominant = input + output;
      model = name;
      contextUsed = positiveNumber(usage.inputTokens);
      contextLimit = positiveNumber(usage.contextWindow) || undefined;
    }
  }
  if (inputTokens + outputTokens === 0 && message.total_cost_usd <= 0) {
    return undefined;
  }
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    ...(message.total_cost_usd > 0 ? { cost: message.total_cost_usd } : {}),
    ...(model ? { model } : {}),
    ...(contextUsed > 0
      ? {
          contextWindow: {
            used: contextUsed,
            ...(contextLimit ? { limit: contextLimit } : {}),
          },
        }
      : {}),
  };
}

function mapTaskStatus(
  status:
    | "pending"
    | "running"
    | "completed"
    | "failed"
    | "killed"
    | "paused"
    | undefined,
): AgentTaskStatus | undefined {
  if (!status) return undefined;
  if (status === "killed") return "cancelled";
  if (status === "paused") return "pending";
  return status;
}

function mapNotificationStatus(
  status: "completed" | "failed" | "stopped",
): AgentTaskStatus {
  return status === "stopped" ? "cancelled" : status;
}

function isTerminalTaskStatus(
  status: AgentTaskStatus,
): status is "completed" | "failed" | "cancelled" {
  return (
    status === "completed" || status === "failed" || status === "cancelled"
  );
}

function toolTerminalEventType(
  status: "completed" | "failed" | "cancelled",
): "tool.completed" | "tool.failed" | "tool.cancelled" {
  if (status === "completed") return "tool.completed";
  if (status === "failed") return "tool.failed";
  return "tool.cancelled";
}

function taskTerminalEventType(
  status: "completed" | "failed" | "cancelled",
): "task.completed" | "task.failed" | "task.cancelled" {
  if (status === "completed") return "task.completed";
  if (status === "failed") return "task.failed";
  return "task.cancelled";
}

function parseMcpToolName(
  name: string,
): { server: string; tool: string } | undefined {
  const match = /^mcp__(.+?)__(.+)$/.exec(name);
  return match?.[1] && match[2]
    ? { server: match[1], tool: match[2] }
    : undefined;
}

function mapMcpServers(
  servers: Record<string, AgentMcpServerConfig>,
): Record<string, McpServerConfig> {
  const mapped: Record<string, McpServerConfig> = {};
  for (const [name, config] of Object.entries(servers)) {
    mapped[name] =
      config.transport === "stdio"
        ? {
            type: "stdio",
            command: config.command,
            ...(config.args ? { args: config.args } : {}),
            ...(config.env ? { env: config.env } : {}),
          }
        : {
            type: config.transport === "sse" ? "sse" : "http",
            url: config.url,
            ...(config.headers ? { headers: config.headers } : {}),
          };
  }
  return mapped;
}

interface RuntimeHookEvent {
  kind: "process.started" | "process.completed";
  processId: string;
  command?: string;
}

function runtimeHooks(
  emit: (event: RuntimeHookEvent) => void,
): Options["hooks"] {
  const onBash: HookCallback = async (input) => {
    const hookInput = recordOf(input);
    const toolInput = recordOf(hookInput?.tool_input);
    const toolResponse = recordOf(hookInput?.tool_response);
    const processId = toolResponse?.backgroundTaskId;
    if (typeof processId === "string") {
      emit({
        kind: "process.started",
        processId,
        ...(typeof toolInput?.command === "string"
          ? { command: toolInput.command }
          : {}),
      });
    }
    return {};
  };
  const onStop: HookCallback = async (input) => {
    const hookInput = recordOf(input);
    const toolInput = recordOf(hookInput?.tool_input);
    const processId = toolInput?.task_id ?? toolInput?.shell_id;
    if (typeof processId === "string") {
      emit({ kind: "process.completed", processId });
    }
    return {};
  };
  return {
    PostToolUse: [
      { matcher: "Bash", hooks: [onBash] },
      { matcher: "TaskStop|KillShell", hooks: [onStop] },
    ],
  };
}

function nativeId(message: SDKMessage): string {
  return "uuid" in message && typeof message.uuid === "string"
    ? message.uuid
    : `derived-${crypto
        .createHash("sha256")
        .update(JSON.stringify(message))
        .digest("hex")
        .slice(0, 24)}`;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return Object.fromEntries(Object.entries(value));
}

function isBackgroundAgentAcknowledgement(value: unknown): boolean {
  const output = recordOf(value);
  return (
    output?.status === "async_launched" || output?.status === "remote_launched"
  );
}

function isPermissionDenial(error: string): boolean {
  return /\b(permission|denied|not allowed|not permitted)\b/i.test(error);
}

function usefulFailureReasonScore(reason: string): number {
  const normalized = reason.trim().toLowerCase();
  if (
    normalized === "permission denied" ||
    normalized === "tool use was denied"
  ) {
    return 0;
  }
  return normalized.length;
}

function positiveNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

function elicitationContent(
  value: unknown,
): Record<string, string | number | boolean | string[]> | undefined {
  const record = recordOf(value);
  if (!record) return undefined;
  const content: Record<string, string | number | boolean | string[]> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (
      typeof entry === "string" ||
      typeof entry === "number" ||
      typeof entry === "boolean" ||
      (Array.isArray(entry) && entry.every((item) => typeof item === "string"))
    ) {
      content[key] = entry;
    }
  }
  return content;
}

function stringifyResult(result: unknown): string {
  if (typeof result === "string") return result;
  if (result === undefined) return "ok";
  return JSON.stringify(result);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
