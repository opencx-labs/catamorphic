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
import { classifyClaudeError } from "./errors.js";
import { hostToolServer, hostToolServers } from "./host-tools.js";
import { inputUuid, renderPrompt } from "./input.js";
import {
  buildQueryOptions,
  ClaudeStartError,
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
  interrupt(): Promise<unknown>;
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
  /** How long a settled turn waits for the CLI to flush and exit. */
  exitGraceMs?: number;
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
  subagents: true,
  streamsText: true,
  streamsReasoning: true,
  nativeState: "store",
  ids: { thread: "strong", turn: "strong", item: "strong" },
};

/**
 * Claude Code as a harness adapter (ADR 0197). The CLI runs beside the
 * runner, so beside the workspace: in the session's sandbox on a server,
 * on the host for the desktop. The adapter is built once with no agent
 * settings; everything per agent arrives in the attempt
 * ({@link readAttemptOptions} lists `AttemptStart.options`).
 */
export function createClaudeCodeAdapter(
  options: ClaudeCodeAdapterOptions = {},
): HarnessAdapter {
  const query: ClaudeQuery = options.query ?? sdkQuery;
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
      }).control(),
  };
}

/** The input stream a streaming-input query reads, open until the turn settles. */
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
function policedServer(
  toolName: string,
  policies: AttemptStart["toolPolicies"],
): { server: string; tool: string } | undefined {
  if (!toolName.startsWith("mcp__")) return undefined;
  const server = Object.keys(policies)
    .filter((name) => toolName.startsWith(`mcp__${name}__`))
    .sort((a, b) => b.length - a.length)[0];
  return server
    ? { server, tool: toolName.slice(`mcp__${server}__`.length) }
    : undefined;
}

/** A host tool call's tool-use id, when the CLI names it in the call's `_meta`. */
function metaToolUseId(meta: unknown): string | undefined {
  if (!meta || typeof meta !== "object") return undefined;
  for (const [key, value] of Object.entries(meta))
    if (/tool_?use_?id/i.test(key) && typeof value === "string") return value;
  return undefined;
}

/** One attempt: one streaming-input query, from its input to its settled turn. */
class ClaudeAttempt {
  private readonly attempt: AttemptStart;
  private readonly host: AttemptHost;
  private readonly query: ClaudeQuery;
  private readonly interruptGraceMs: number;
  private readonly exitGraceMs: number;
  private readonly inputs = new InputQueue();
  private readonly abort = new AbortController();
  private readonly transcript: ClaudeTranscript;
  /** Steered inputs not yet taken into the turn, by SDK uuid. */
  private readonly pendingSteers = new Map<string, string>();
  private handle?: ClaudeQueryHandle;
  private threadEmitted = false;
  private interruptRequested = false;
  private interruptTimer?: ReturnType<typeof setTimeout>;
  private settled = false;
  private stderr = "";
  /** Starts the wait for the CLI to exit, once the turn settled. */
  private onSettled = () => {};

  constructor(input: {
    attempt: AttemptStart;
    host: AttemptHost;
    query: ClaudeQuery;
    interruptGraceMs: number;
    exitGraceMs: number;
  }) {
    this.attempt = input.attempt;
    this.host = input.host;
    this.query = input.query;
    this.interruptGraceMs = input.interruptGraceMs;
    this.exitGraceMs = input.exitGraceMs;
    this.transcript = new ClaudeTranscript(
      (event) => this.host.emit(event),
      new Set(this.attempt.hostTools.map(hostToolServer)),
    );
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
    let options: Options;
    try {
      const prompt = await renderPrompt({
        ...input,
        stateDirectory: this.attempt.stateDirectory,
      });
      this.inputs.push(
        this.userMessage({ itemId: input.itemId, text: prompt }),
      );
      options = this.options();
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
    try {
      this.handle = this.query({ prompt: this.inputs, options });
      await this.pump(this.handle);
      if (!this.settled) this.settleWithoutResult();
    } catch (error) {
      if (!this.settled) this.settleWithoutResult(error);
    } finally {
      this.inputs.end();
      this.handle?.close();
    }
  }

  /** Read the query to its end; after the turn settles, only until the CLI exits. */
  private async pump(handle: ClaudeQueryHandle): Promise<void> {
    const iterator = handle[Symbol.asyncIterator]();
    let exitTimer: ReturnType<typeof setTimeout> | undefined;
    const exited = new Promise<"timeout">((resolve) => {
      this.onSettled = () => {
        exitTimer = setTimeout(() => resolve("timeout"), this.exitGraceMs);
      };
    });
    try {
      for (;;) {
        const reading = iterator.next();
        // A read still pending when the exit wait gives up may reject later.
        reading.catch(() => {});
        const next = await Promise.race([reading, exited]);
        if (next === "timeout" || next.done) return;
        this.observe(next.value);
      }
    } finally {
      clearTimeout(exitTimer);
    }
  }

  private observe(message: SDKMessage): void {
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
      if (
        Reflect.get(message, "state") === "started" &&
        typeof uuid === "string"
      )
        this.consume([uuid]);
      return;
    }
    if (message.type !== "result") {
      this.transcript.handle(message);
      return;
    }
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
    if (this.interruptRequested || this.abort.signal.aborted) {
      this.settle({ status: "interrupted" });
      return;
    }
    const stderr = this.stderr.trim();
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
    clearTimeout(this.interruptTimer);
    this.transcript.close({ interrupted: input.status === "interrupted" });
    const last = this.transcript.lastAssistantUuid;
    this.host.emit({
      type: "turn.completed",
      status: input.status,
      ...(input.error ? { error: input.error } : {}),
      ...(last ? { ref: { id: last, strength: "strong" } } : {}),
    });
    // No more input: the CLI flushes its transcript and exits.
    this.inputs.end();
    this.onSettled();
  }

  private userMessage(input: { itemId: string; text: string }): SDKUserMessage {
    return {
      type: "user",
      message: { role: "user", content: input.text },
      parent_tool_use_id: null,
      uuid: inputUuid(input.itemId),
    };
  }

  private async steer(input: {
    itemId: string;
    text: string;
    attachments: AgentAttachment[];
  }): Promise<boolean> {
    if (this.settled || this.interruptRequested || !this.handle) return false;
    const prompt = await renderPrompt({
      ...input,
      stateDirectory: this.attempt.stateDirectory,
    });
    if (this.settled || this.interruptRequested) return false;
    const message = this.userMessage({ itemId: input.itemId, text: prompt });
    if (message.uuid) this.pendingSteers.set(message.uuid, input.itemId);
    // "next" folds the input into the running turn at its next step; "now"
    // would abort the step in flight.
    this.inputs.push({ ...message, priority: "next" });
    return true;
  }

  private interrupt(): void {
    if (this.settled || this.interruptRequested) return;
    this.interruptRequested = true;
    const handle = this.handle;
    if (!handle) {
      this.abort.abort();
      return;
    }
    this.interruptTimer = setTimeout(
      () => this.abort.abort(),
      this.interruptGraceMs,
    );
    void handle.interrupt().catch(() => this.abort.abort());
  }

  private options(): Options {
    const attempt = this.attempt;
    const own =
      attempt.thread.mode === "fresh"
        ? attempt.thread.providerThreadId
        : attempt.thread.mode === "fork"
          ? undefined
          : attempt.thread.nativeRef.id;
    const source =
      attempt.thread.mode === "fork" ? attempt.thread.source.id : undefined;
    const live = { turnContext: attempt.context.trim() || undefined };
    const onMcpResult: HookCallback = async (hookInput) => {
      const toolUseId = Reflect.get(hookInput, "tool_use_id");
      if (typeof toolUseId === "string")
        this.transcript.mcpResult(
          toolUseId,
          extractMcpToolResult(Reflect.get(hookInput, "tool_response")),
        );
      return {};
    };
    return buildQueryOptions({
      attempt,
      options: readAttemptOptions(attempt.options),
      hostServers: hostToolServers({
        tools: attempt.hostTools,
        call: (call) => this.host.callTool(call),
        toolUseId: ({ server, name, meta }) =>
          metaToolUseId(meta) ?? this.transcript.takeHostCall(server, name),
      }),
      canUseTool: this.canUseTool,
      onElicitation: this.onElicitation,
      hooks: {
        PostToolUse: [{ matcher: "^mcp__", hooks: [onMcpResult] }],
        ...turnContextHooks(live),
      },
      sessionStore: hostSessionStore({
        nativeState: this.host.nativeState,
        // A fork reads its source thread; everything else is the
        // attempt's own (named only when it is not).
        threadFor: (sessionId) =>
          sessionId === own || (source !== undefined && sessionId !== source)
            ? undefined
            : sessionId,
      }),
      abortController: this.abort,
      stderr: (data) => {
        this.stderr = (this.stderr + data).slice(-8_000);
      },
    });
  }

  private readonly canUseTool: CanUseTool = async (
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
    const mcp = parseMcpToolName(toolName);
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

  private readonly onElicitation: OnElicitation = async (
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
