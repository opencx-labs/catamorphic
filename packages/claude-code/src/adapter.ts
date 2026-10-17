import {
  type CanUseTool,
  type ElicitationResult,
  type HookCallback,
  type OnElicitation,
  type Options,
  type PermissionResult,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
  query as sdkQuery,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentAttachment,
  JsonObject,
  JsonValue,
  TurnError,
} from "@catamorphic/agent-protocol";
import {
  type AttemptControl,
  type AttemptHost,
  type AttemptStart,
  type HarnessAdapter,
  type HarnessCapabilities,
  RequestClosedError,
} from "@catamorphic/agent-protocol/runner";
import {
  type WarmSession,
  WarmSessions,
  type WarmSessionsOptions,
} from "@catamorphic/sandbox";
import { classifyClaudeError } from "./errors.js";
import { hostToolServer, hostToolServers } from "./host-tools.js";
import { inputUuid, renderPrompt } from "./input.js";
import {
  buildQueryOptions,
  ClaudeStartError,
  launchSignature,
  readAttemptOptions,
} from "./options.js";
import { askUserAnswerInput, parseAskUserQuestions } from "./questions.js";
import { hostSessionStore } from "./session-store.js";
import {
  ClaudeTranscript,
  extractMcpToolResult,
  parseMcpToolName,
} from "./transcript.js";
import { turnContextHooks } from "./turn-context.js";
import { turnUsageFromResult } from "./usage.js";

/** What the adapter needs of a running query: its messages, interrupt and close. */
export interface ClaudeQueryHandle extends AsyncIterable<SDKMessage> {
  /**
   * Stop the turn. `cancelQueued` also withdraws the input still waiting in
   * the CLI's queue, which would otherwise run as its next turn (the CLI's
   * `interrupt_cancel_queued_v1`).
   */
  interrupt(options?: { cancelQueued?: boolean }): Promise<unknown>;
  close(): void;
}

/** The Agent SDK's `query`, or a stand-in (a replayed transcript in tests). */
export type ClaudeQuery = (params: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: Options;
}) => ClaudeQueryHandle;

export interface ClaudeCodeAdapterOptions {
  /** Replaces the SDK transport; tests pass a transcript replay. */
  query?: ClaudeQuery;
  /** How long an interrupt waits for the CLI to stop before aborting it. */
  interruptGraceMs?: number;
  /** How long a closing CLI may take to flush and exit. */
  exitGraceMs?: number;
  /**
   * Keep each thread's CLI up between attempts (ADR 0222). Only for hosts
   * that keep the adapter for their lifetime and call `dispose` when they
   * stop: a runner that exits with its attempt leaves it unset, and every
   * attempt's CLI exits when the attempt settles.
   */
  warm?: WarmSessionsOptions;
}

export const CLAUDE_CODE_CAPABILITIES: HarnessCapabilities = {
  steer: true,
  interrupt: true,
  // Core resends the input; the CLI has no "run the last turn again".
  retry: false,
  fork: true,
  // A rollback forks through the turn before it.
  rollback: true,
  questions: true,
  approvals: true,
  elicitations: true,
  // Tool search defers MCP tools until the model looks for them.
  toolSearch: true,
  subagents: true,
  streamsText: true,
  streamsReasoning: true,
  nativeState: "store",
  ids: { thread: "strong", turn: "strong", item: "strong" },
};

/**
 * Claude Code as a harness adapter (ADR 0198). The CLI runs beside the
 * runner, so beside the workspace: in the session's sandbox on a server,
 * on the host for the desktop. The adapter is built once with no agent
 * settings; everything per agent arrives in the attempt
 * ({@link readAttemptOptions} lists `AttemptStart.options`). With `warm`,
 * a thread's CLI serves its next attempt too when nothing it started with
 * changed (ADR 0222).
 */
export function createClaudeCodeAdapter(
  options: ClaudeCodeAdapterOptions = {},
): HarnessAdapter {
  const query: ClaudeQuery = options.query ?? sdkQuery;
  const sessions = options.warm
    ? new WarmSessions<ClaudeSession>(options.warm)
    : undefined;
  return {
    id: "claude-code",
    capabilities: () => CLAUDE_CODE_CAPABILITIES,
    start: (attempt, host) =>
      new ClaudeAttempt({
        attempt,
        host,
        query,
        interruptGraceMs: options.interruptGraceMs ?? 5_000,
        exitGraceMs: options.exitGraceMs ?? 10_000,
        sessions,
      }).control(),
    ...(sessions ? { dispose: () => sessions.dispose() } : {}),
  };
}

/** The input stream a streaming-input query reads, open while its CLI serves. */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private readonly items: SDKUserMessage[] = [];
  private wake?: () => void;
  ended = false;

  push(message: SDKUserMessage): void {
    this.items.push(message);
    this.wake?.();
  }

  end(): void {
    this.ended = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      const next = this.items.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.ended) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
      this.wake = undefined;
    }
  }
}

function toJson(value: unknown): JsonValue {
  const parsed: JsonValue = JSON.parse(JSON.stringify(value ?? null));
  return parsed;
}

function toJsonObject(value: unknown): JsonObject {
  const json = toJson(value);
  return json && typeof json === "object" && !Array.isArray(json) ? json : {};
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Form content an MCP elicitation result may carry. */
function elicitationContent(
  value: JsonValue | undefined,
): Record<string, string | number | boolean | string[]> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const content: Record<string, string | number | boolean | string[]> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (
      typeof entry === "string" ||
      typeof entry === "number" ||
      typeof entry === "boolean"
    )
      content[key] = entry;
    else if (Array.isArray(entry))
      content[key] = entry.filter(
        (item): item is string => typeof item === "string",
      );
  }
  return content;
}

/** The server policies govern for a tool, longest key first (`a__b` before `a`). */
export function policedServer(
  toolName: string,
  policies: AttemptStart["toolPolicies"],
): { server: string; tool: string } | undefined {
  const mcp = parseMcpToolName(toolName, Object.keys(policies));
  // Own keys only: a server named `toString` has no policy.
  return mcp && Object.hasOwn(policies, mcp.server) ? mcp : undefined;
}

/** A host tool call's tool-use id, when the CLI names it in the call's `_meta`. */
function metaToolUseId(meta: unknown): string | undefined {
  if (!meta || typeof meta !== "object") return undefined;
  for (const [key, value] of Object.entries(meta))
    if (/tool_?use_?id/i.test(key) && typeof value === "string") return value;
  return undefined;
}

/** The native thread an attempt continues, when it continues one. */
function continuedThread(attempt: AttemptStart): string | undefined {
  const thread = attempt.thread;
  return thread.mode === "resume" || thread.mode === "restore"
    ? thread.nativeRef.id
    : undefined;
}

/**
 * One Claude Code CLI: a streaming-input query that serves the attempts of
 * its thread one at a time (ADR 0222). Everything the CLI calls back with
 * (tool permissions, questions, host tools, its transcript, the turn's
 * context) reaches the attempt it serves now; between attempts it is idle,
 * and what it reports then reaches nobody.
 */
class ClaudeSession implements WarmSession {
  readonly inputs = new InputQueue();
  readonly abort = new AbortController();
  /** The UserPromptSubmit hook's per-turn context: the serving attempt's. */
  readonly live: { turnContext?: string } = {};
  /** The native session id, once the CLI names it. */
  nativeId?: string;
  /** The native turn its last attempt ended on (an assistant uuid). */
  lastTurn?: string;
  stderr = "";
  private handle?: ClaudeQueryHandle;
  private serving?: ClaudeAttempt;
  private ended = false;
  private resolveExited!: () => void;
  readonly exited = new Promise<void>((resolve) => {
    this.resolveExited = resolve;
  });
  /** Called once the CLI's message stream ends. */
  onExit = () => {};

  constructor(
    /** Everything the CLI was started with ({@link launchSignature}). */
    readonly signature: string,
    private readonly exitGraceMs: number,
  ) {}

  get alive(): boolean {
    return !this.ended && !this.inputs.ended && !this.abort.signal.aborted;
  }

  /** The attempt the CLI serves now. */
  get attempt(): ClaudeAttempt | undefined {
    return this.serving;
  }

  serve(attempt: ClaudeAttempt, turnContext: string | undefined): void {
    this.serving = attempt;
    this.live.turnContext = turnContext;
  }

  release(attempt: ClaudeAttempt): void {
    if (this.serving !== attempt) return;
    this.serving = undefined;
    this.live.turnContext = undefined;
  }

  start(query: ClaudeQuery, options: Options): void {
    this.handle = query({ prompt: this.inputs, options });
    void this.read(this.handle);
  }

  /**
   * Stop the turn and withdraw what waits in the CLI's queue: input Work
   * steered that the turn never read goes on as Work's own (a restart's
   * prompt, or a turn of its own), never also as the CLI's next turn.
   */
  interrupt(): Promise<unknown> {
    return this.handle
      ? this.handle.interrupt({ cancelQueued: true })
      : Promise.resolve();
  }

  private async read(handle: ClaudeQueryHandle): Promise<void> {
    let failure: unknown;
    try {
      for await (const message of handle) {
        if (!this.nativeId && "session_id" in message && message.session_id)
          this.nativeId = message.session_id;
        this.serving?.observe(message);
      }
    } catch (error) {
      failure = error;
    } finally {
      this.ended = true;
      handle.close();
      this.resolveExited();
      this.onExit();
    }
    this.serving?.harnessEnded(failure);
  }

  /** End the CLI: no more input, so it flushes and exits; aborted when it lingers. */
  async close(): Promise<void> {
    this.inputs.end();
    if (!this.handle) {
      this.ended = true;
      this.resolveExited();
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const lingering = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), this.exitGraceMs);
    });
    const outcome = await Promise.race([this.exited, lingering]);
    clearTimeout(timer);
    if (outcome === "timeout") {
      this.abort.abort();
      this.handle.close();
    }
  }
}

/** One attempt: its input run to a settled turn on a thread's CLI. */
class ClaudeAttempt {
  private readonly attempt: AttemptStart;
  private readonly host: AttemptHost;
  private readonly query: ClaudeQuery;
  private readonly interruptGraceMs: number;
  private readonly exitGraceMs: number;
  private readonly sessions?: WarmSessions<ClaudeSession>;
  /** Every MCP server name the attempt configured, host servers included. */
  private readonly servers: readonly string[];
  readonly transcript: ClaudeTranscript;
  private session?: ClaudeSession;
  /** Where the session's stderr stood when this attempt began. */
  private stderrFrom = 0;
  /** Steered inputs not yet taken into the turn, by SDK uuid. */
  private readonly pendingSteers = new Map<string, string>();
  /** The SDK uuid of this attempt's own input, once sent. */
  private ownInputUuid?: string;
  /** The CLI started running this attempt's own input. */
  private ownInputStarted = false;
  /** The CLI finished a native turn of this attempt. */
  private resultSeen = false;
  private threadEmitted = false;
  private interruptRequested = false;
  private interruptTimer?: ReturnType<typeof setTimeout>;
  private settled = false;
  /** The turn settled as failed. */
  private failed = false;
  private resolveSettled!: () => void;
  private readonly settledTurn = new Promise<void>((resolve) => {
    this.resolveSettled = resolve;
  });

  constructor(input: {
    attempt: AttemptStart;
    host: AttemptHost;
    query: ClaudeQuery;
    interruptGraceMs: number;
    exitGraceMs: number;
    sessions: WarmSessions<ClaudeSession> | undefined;
  }) {
    this.attempt = input.attempt;
    this.host = input.host;
    this.query = input.query;
    this.interruptGraceMs = input.interruptGraceMs;
    this.exitGraceMs = input.exitGraceMs;
    this.sessions = input.sessions;
    const hostServers = new Set(this.attempt.hostTools.map(hostToolServer));
    this.servers = [...Object.keys(this.attempt.mcpServers), ...hostServers];
    this.transcript = new ClaudeTranscript(
      (event) => this.host.emit(event),
      hostServers,
      this.servers,
    );
  }

  /** The host this attempt reports to: the session's callbacks reach it. */
  get attemptHost(): AttemptHost {
    return this.host;
  }

  control(): AttemptControl {
    const onStop = () => this.interrupt();
    this.host.signal.addEventListener("abort", onStop, { once: true });
    const finished = this.run().finally(() => {
      this.host.signal.removeEventListener("abort", onStop);
      clearTimeout(this.interruptTimer);
    });
    return {
      steer: (input) => this.steer(input),
      interrupt: () => this.interrupt(),
      finished,
    };
  }

  private async run(): Promise<void> {
    const input = this.attempt.input;
    if (!input) {
      this.settle({
        status: "failed",
        error: {
          message:
            "Claude Code cannot run a turn again without its input. Send the message again.",
        },
      });
      return;
    }
    let message: SDKUserMessage;
    let signature: string;
    let debugging: boolean;
    try {
      const prompt = await renderPrompt({
        ...input,
        stateDirectory: this.attempt.stateDirectory,
      });
      message = this.userMessage({ itemId: input.itemId, text: prompt });
      const options = readAttemptOptions(this.attempt.options);
      signature = launchSignature({ attempt: this.attempt, options });
      debugging = options.debugFile !== undefined;
    } catch (error) {
      this.settle({
        status: "failed",
        error: {
          message:
            error instanceof ClaudeStartError
              ? error.message
              : `Claude Code could not start: ${errorMessage(error)}`,
        },
      });
      return;
    }
    if (this.interruptRequested) {
      this.settle({ status: "interrupted" });
      return;
    }
    const warm = await this.warmSession(signature);
    if (this.interruptRequested) {
      // Stopped before its input reached the CLI: a warm one is untouched.
      if (warm?.nativeId) {
        warm.release(this);
        this.sessions?.release(warm.nativeId, warm);
      }
      this.settle({ status: "interrupted" });
      return;
    }
    const session = warm ?? this.coldSession(signature);
    if (!session) return;
    this.session = session;
    this.stderrFrom = session.stderr.length;
    this.ownInputUuid = message.uuid;
    session.inputs.push(message);
    await this.settledTurn;
    const thread = session.nativeId;
    // A failed turn's CLI ends: whatever failed it (an expired sign-in, a
    // broken connection) should not meet the retry. So does one writing a
    // debug log, which covers its own attempt only.
    if (
      this.sessions &&
      thread &&
      session.alive &&
      !this.failed &&
      !debugging
    ) {
      session.release(this);
      this.sessions.release(thread, session);
      return;
    }
    // The CLI flushes its transcript and exits; the attempt holds on until
    // it has, so whatever it stores on its way out reaches Work.
    await session.close();
    session.release(this);
  }

  /** The thread's idle CLI, when nothing it started with changed since. */
  private async warmSession(
    signature: string,
  ): Promise<ClaudeSession | undefined> {
    const thread = continuedThread(this.attempt);
    if (!this.sessions || !thread) return undefined;
    const lastTurn =
      this.attempt.thread.mode === "resume" ||
      this.attempt.thread.mode === "restore"
        ? this.attempt.thread.lastTurnRef?.id
        : undefined;
    const session = await this.sessions.take(
      thread,
      (candidate) =>
        candidate.signature === signature &&
        candidate.nativeId === thread &&
        candidate.lastTurn === lastTurn,
    );
    session?.serve(this, this.attempt.context.trim() || undefined);
    return session;
  }

  /** A new CLI for this attempt's thread, resumed from Work's copy of it. */
  private coldSession(signature: string): ClaudeSession | undefined {
    const session = new ClaudeSession(signature, this.exitGraceMs);
    // A resumed thread's history ends where Work last recorded it.
    const thread = this.attempt.thread;
    if (thread.mode === "resume" || thread.mode === "restore")
      session.lastTurn = thread.lastTurnRef?.id;
    session.serve(this, this.attempt.context.trim() || undefined);
    let options: Options;
    try {
      options = this.options(session);
    } catch (error) {
      session.release(this);
      this.settle({
        status: "failed",
        error: {
          message:
            error instanceof ClaudeStartError
              ? error.message
              : `Claude Code could not start: ${errorMessage(error)}`,
        },
      });
      return undefined;
    }
    const sessions = this.sessions;
    session.onExit = () => {
      if (session.nativeId) sessions?.forget(session.nativeId, session);
    };
    session.start(this.query, options);
    return session;
  }

  observe(message: SDKMessage): void {
    if (!this.threadEmitted && "session_id" in message && message.session_id) {
      this.threadEmitted = true;
      this.host.emit({
        type: "thread",
        ref: { id: message.session_id, strength: "strong" },
      });
      this.host.emit({ type: "turn.started" });
    }
    if (this.settled) return;
    // Lifecycle frames are not in the SDK's message union; a steered
    // input's "started" says the turn took it in.
    const kind: string = message.type;
    if (kind === "command_lifecycle") {
      const uuid = Reflect.get(message, "command_uuid");
      const state = Reflect.get(message, "state");
      if (typeof uuid !== "string") return;
      if (state === "started") {
        if (uuid === this.ownInputUuid) this.ownInputStarted = true;
        this.consume([uuid]);
        return;
      }
      // Withdrawn with an interrupt, never read: Work runs it itself.
      if (state === "cancelled") this.pendingSteers.delete(uuid);
      // The CLI ended this attempt's own input before running anything: no
      // turn and no result will follow, though it stays up for more input.
      if (
        uuid === this.ownInputUuid &&
        !this.ownInputStarted &&
        !this.resultSeen &&
        (state === "completed" || state === "cancelled" || state === "refused")
      )
        this.settleWithoutResult(
          new Error(
            "Claude Code ended the message without running it. Retry to send it again.",
          ),
        );
      return;
    }
    if (message.type !== "result") {
      this.transcript.handle(message);
      return;
    }
    this.resultSeen = true;
    this.consume([
      ...(message.user_message_uuids ?? []),
      ...(message.user_message_uuid ? [message.user_message_uuid] : []),
    ]);
    // Steered input the CLI queued rather than folded in, and a background
    // subagent's report, run as more native turns of this same Work turn.
    const more =
      !this.interruptRequested &&
      !message.is_error &&
      message.subtype === "success" &&
      ((message.queued_turn_count ?? 0) > 0 ||
        this.pendingSteers.size > 0 ||
        // A native background subagent's notification continues the turn.
        this.transcript.backgroundAgents > 0);
    if (!more) this.settleFromResult(message);
  }

  /** The CLI's messages ended (it exited) while this attempt was its own. */
  harnessEnded(error?: unknown): void {
    if (!this.settled) this.settleWithoutResult(error);
  }

  private consume(uuids: string[]): void {
    const itemIds = uuids.flatMap((uuid) => {
      const itemId = this.pendingSteers.get(uuid);
      if (!itemId) return [];
      this.pendingSteers.delete(uuid);
      return [itemId];
    });
    if (itemIds.length > 0) this.host.emit({ type: "input.consumed", itemIds });
  }

  private settleFromResult(result: SDKResultMessage): void {
    const usage = turnUsageFromResult({
      result,
      lastMainUsage: this.transcript.lastMainUsage,
    });
    if (usage) this.host.emit({ type: "usage", usage });
    if (this.interruptRequested) {
      this.settle({ status: "interrupted" });
      return;
    }
    if (result.subtype === "success" && !result.is_error) {
      this.settle({ status: "completed" });
      return;
    }
    const message =
      (result.subtype === "success"
        ? result.result || this.transcript.errorText
        : result.errors.filter(Boolean).join("\n") ||
          this.transcript.errorText) || result.subtype;
    const providerRejected =
      this.transcript.sdkError !== undefined ||
      (result.subtype === "success" &&
        typeof result.api_error_status === "number");
    this.settle({
      status: "failed",
      error: this.turnError({ message, providerRejected }),
    });
  }

  private settleWithoutResult(error?: unknown): void {
    if (
      this.interruptRequested ||
      this.session?.abort.signal.aborted === true
    ) {
      this.settle({ status: "interrupted" });
      return;
    }
    const stderr = (this.session?.stderr ?? "").slice(this.stderrFrom).trim();
    const message = error
      ? errorMessage(error)
      : "Claude Code stopped before finishing its turn.";
    if (stderr)
      this.host.emit({
        type: "diagnostic",
        level: "error",
        message: `Claude Code: ${stderr.slice(-2_000)}`,
      });
    this.settle({
      status: "failed",
      error: this.turnError({ message, providerRejected: false }),
    });
  }

  private turnError(input: {
    message: string;
    providerRejected: boolean;
  }): TurnError {
    const kind = classifyClaudeError({
      message: input.message,
      ...(this.transcript.sdkError
        ? { sdkError: this.transcript.sdkError }
        : {}),
    });
    return {
      message: input.message,
      ...(kind ? { kind } : {}),
      // Safe to send again only when the provider turned the turn away
      // before any tool ran.
      ...(kind && input.providerRejected && !this.transcript.workStarted
        ? { retrySafe: true }
        : {}),
    };
  }

  private settle(input: {
    status: "completed" | "failed" | "interrupted";
    error?: TurnError;
  }): void {
    if (this.settled) return;
    this.settled = true;
    this.failed = input.status === "failed";
    clearTimeout(this.interruptTimer);
    this.transcript.close({ interrupted: input.status === "interrupted" });
    const last = this.transcript.lastAssistantUuid;
    if (last && this.session) this.session.lastTurn = last;
    this.host.emit({
      type: "turn.completed",
      status: input.status,
      ...(input.error ? { error: input.error } : {}),
      ...(last ? { ref: { id: last, strength: "strong" } } : {}),
    });
    this.resolveSettled();
  }

  private userMessage(input: { itemId: string; text: string }): SDKUserMessage {
    return {
      type: "user",
      message: { role: "user", content: input.text },
      parent_tool_use_id: null,
      uuid: inputUuid({
        attemptId: this.attempt.attemptId,
        itemId: input.itemId,
      }),
    };
  }

  private async steer(input: {
    itemId: string;
    text: string;
    attachments: AgentAttachment[];
  }): Promise<boolean> {
    if (this.settled || this.interruptRequested || !this.session) return false;
    const prompt = await renderPrompt({
      ...input,
      stateDirectory: this.attempt.stateDirectory,
    });
    const session = this.session;
    if (this.settled || this.interruptRequested || !session.alive) return false;
    const message = this.userMessage({ itemId: input.itemId, text: prompt });
    if (message.uuid) this.pendingSteers.set(message.uuid, input.itemId);
    // "next" folds the input into the running turn at its next step; "now"
    // would abort the step in flight.
    session.inputs.push({ ...message, priority: "next" });
    return true;
  }

  private interrupt(): void {
    if (this.settled || this.interruptRequested) return;
    this.interruptRequested = true;
    const session = this.session;
    // Not started yet: the attempt settles as soon as `run` looks again.
    if (!session) return;
    this.interruptTimer = setTimeout(
      () => session.abort.abort(),
      this.interruptGraceMs,
    );
    void session.interrupt().catch(() => session.abort.abort());
  }

  /**
   * The SDK options a new CLI starts with. Its callbacks reach whichever
   * attempt the session serves when they fire, so they stay right for the
   * attempts after this one.
   */
  private options(session: ClaudeSession): Options {
    const attempt = this.attempt;
    const own =
      attempt.thread.mode === "fresh"
        ? attempt.thread.providerThreadId
        : attempt.thread.mode === "fork"
          ? undefined
          : attempt.thread.nativeRef.id;
    const source =
      attempt.thread.mode === "fork" ? attempt.thread.source.id : undefined;
    const onMcpResult: HookCallback = async (hookInput) => {
      const toolUseId = Reflect.get(hookInput, "tool_use_id");
      if (typeof toolUseId === "string")
        session.attempt?.transcript.mcpResult(
          toolUseId,
          extractMcpToolResult(Reflect.get(hookInput, "tool_response")),
        );
      return {};
    };
    const serving = () => {
      const current = session.attempt;
      if (!current)
        throw new Error("Claude Code called back between turns of its chat.");
      return current;
    };
    const nativeState: AttemptHost["nativeState"] = {
      // What the CLI stores between turns (it writes nothing then, only
      // metadata as it exits) has no attempt to reach.
      append: (input) =>
        session.attempt
          ? session.attempt.attemptHost.nativeState.append(input)
          : Promise.resolve(),
      load: (input) =>
        session.attempt
          ? session.attempt.attemptHost.nativeState.load(input)
          : Promise.resolve(null),
      subpaths: (input) =>
        session.attempt
          ? session.attempt.attemptHost.nativeState.subpaths(input)
          : Promise.resolve([]),
    };
    return buildQueryOptions({
      attempt,
      options: readAttemptOptions(attempt.options),
      hostServers: hostToolServers({
        tools: attempt.hostTools,
        call: (call) => serving().attemptHost.callTool(call),
        toolUseId: ({ server, name, meta }) =>
          metaToolUseId(meta) ??
          session.attempt?.transcript.takeHostCall(server, name),
      }),
      canUseTool: (toolName, toolInput, callOptions) =>
        session.attempt
          ? session.attempt.canUseTool(toolName, toolInput, callOptions)
          : Promise.resolve({
              behavior: "deny",
              message: "The turn already ended.",
            }),
      onElicitation: (request, callOptions) =>
        session.attempt
          ? session.attempt.onElicitation(request, callOptions)
          : Promise.resolve({ action: "cancel" }),
      hooks: {
        PostToolUse: [{ matcher: "^mcp__", hooks: [onMcpResult] }],
        ...turnContextHooks(session.live),
      },
      sessionStore: hostSessionStore({
        nativeState,
        // A fork reads its source thread; everything else is the
        // attempt's own (named only when it is not).
        threadFor: (sessionId) =>
          sessionId === own || (source !== undefined && sessionId !== source)
            ? undefined
            : sessionId,
      }),
      abortController: session.abort,
      stderr: (data) => {
        session.stderr = (session.stderr + data).slice(-8_000);
      },
    });
  }

  readonly canUseTool: CanUseTool = async (
    toolName,
    toolInput,
    { signal, toolUseID },
  ): Promise<PermissionResult> => {
    if (toolName === "AskUserQuestion")
      return this.ask({ toolInput, toolUseID, signal });
    const policed = policedServer(toolName, this.attempt.toolPolicies);
    if (policed) {
      const verdict = await this.host.authorize({
        server: policed.server,
        tool: policed.tool,
        input: toJson(toolInput),
        itemKey: toolUseID,
        signal,
      });
      return verdict.allowed
        ? { behavior: "allow", updatedInput: toolInput }
        : { behavior: "deny", message: verdict.message };
    }
    const mcp = parseMcpToolName(toolName, this.servers);
    return {
      behavior: "deny",
      message: mcp
        ? `The tool "${mcp.tool}" on ${mcp.server} is not available to this agent.`
        : `The ${toolName} tool is not available to this agent.`,
    };
  };

  /** AskUserQuestion: the person answers in Work, and the tool returns the answers. */
  private async ask(input: {
    toolInput: Record<string, unknown>;
    toolUseID: string;
    signal: AbortSignal;
  }): Promise<PermissionResult> {
    const key = `question:${input.toolUseID}`;
    const questions = parseAskUserQuestions(input.toolInput);
    const onAbort = () =>
      this.host.emit({
        type: "request.closed",
        key,
        reason: "The turn stopped before the question was answered.",
      });
    input.signal.addEventListener("abort", onAbort, { once: true });
    try {
      const response = await this.host.request(key, {
        kind: "question",
        blocking: true,
        title: questions[0]?.header ?? "Question",
        origin: {
          kind: "tool",
          id: "AskUserQuestion",
          displayName: "Ask User",
        },
        questions,
      });
      if (response.kind !== "question")
        return {
          behavior: "deny",
          message: "The question was not answered.",
        };
      return {
        behavior: "allow",
        updatedInput: askUserAnswerInput({
          toolInput: input.toolInput,
          answers: response.answers,
        }),
      };
    } catch (error) {
      if (error instanceof RequestClosedError)
        return {
          behavior: "deny",
          message: `The question was closed without an answer: ${error.reason}`,
          interrupt: true,
        };
      throw error;
    } finally {
      input.signal.removeEventListener("abort", onAbort);
    }
  }

  readonly onElicitation: OnElicitation = async (
    request,
    { requestId },
  ): Promise<ElicitationResult> => {
    const schema = request.requestedSchema
      ? toJsonObject(request.requestedSchema)
      : undefined;
    try {
      const response = await this.host.request(`elicitation:${requestId}`, {
        kind: "elicitation",
        blocking: true,
        title: request.title ?? request.message,
        ...(request.description ? { description: request.description } : {}),
        origin: {
          kind: "mcp",
          id: request.serverName,
          ...(request.displayName ? { displayName: request.displayName } : {}),
        },
        elicitation: {
          server: request.serverName,
          message: request.message,
          ...(schema ? { schema } : {}),
          ...(request.url ? { url: request.url } : {}),
        },
      });
      if (response.kind !== "elicitation") return { action: "cancel" };
      const content =
        response.action === "accept"
          ? elicitationContent(response.content)
          : undefined;
      return { action: response.action, ...(content ? { content } : {}) };
    } catch (error) {
      if (error instanceof RequestClosedError) return { action: "cancel" };
      throw error;
    }
  };
}
