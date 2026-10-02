import path from "node:path";
import type {
  AgentAttachment,
  AgentEffort,
  AgentTurnUsage,
  JsonValue,
  NativeRef,
  TurnError,
} from "@catamorphic/agent-protocol";
import {
  type AttemptControl,
  type AttemptHost,
  type AttemptStart,
  type HarnessAdapter,
  type HarnessCapabilities,
  type HarnessEvent,
  type HostToolResult,
  type McpServerSpec,
  RequestClosedError,
  type RequestDraft,
} from "@catamorphic/agent-protocol/runner";
import {
  type ConnectedMcpServer,
  connectMcpServer,
  type ElicitHandler,
  type ElicitRequest,
  type ElicitResult,
} from "@catamorphic/mcp";
import {
  isMediaAttachment,
  positiveTokenCount,
  reasoningHeading,
  renderUserMessage,
} from "@catamorphic/sandbox";
import {
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
  stepCountIs,
  type TextStreamPart,
  type Tool,
  ToolLoopAgent,
} from "ai";
import { z } from "zod";
import { classifyModelError, errorMessage } from "./errors.js";
import type { ShellState } from "./shell.js";
import { agentTelemetry } from "./telemetry.js";
import {
  entriesThroughTurn,
  type FoldedThread,
  foldThread,
  parseThreadEntries,
  storedEntries,
  type ThreadEntry,
  toJsonValue,
} from "./thread.js";
import {
  type AiSdkSandboxProvider,
  conversationTools,
  hostTools,
  isRecord,
  mcpTools,
  parseHostToolResult,
  resolveProjectPath,
  type ToolMeta,
  type ToolSetWithMeta,
  transcriptToolResult,
  workspaceTools,
} from "./tools.js";

/** The adapter id: an attempt's `harness` names it. */
export const AI_SDK_HARNESS = "ai-sdk";

const DEFAULT_INSTRUCTIONS = `You are an agent working with a person in their project folder, which can hold any kind of work: documents, notes, data, code, automations, apps.
Use the provided tools to inspect and edit the project in your working directory.
Read AGENTS.md and relevant .work/skills/*/SKILL.md and .agents/skills/*/SKILL.md files, when they exist, before making substantial changes.
Keep changes focused, run relevant checks, and do not commit changes.
At the start of a new conversation, once the topic is clear from the first user message, call set_title with a concise conversation title; update it whenever the current title no longer fits the conversation, but not for minor detours.`;

/**
 * The AI SDK's default stop condition is stepCountIs(20), far too small for
 * real work (scaffold, build, fix, rebuild easily exceeds it), and it ends
 * the turn silently mid-work. Interruption stays available; the cap is a
 * runaway guard.
 */
const DEFAULT_MAX_STEPS = 150;

const CAPABILITIES: HarnessCapabilities = {
  steer: true,
  interrupt: true,
  retry: true,
  fork: true,
  rollback: false,
  questions: true,
  approvals: true,
  elicitations: true,
  subagents: false,
  streamsText: true,
  streamsReasoning: true,
  nativeState: "store",
  ids: { thread: "strong", turn: "strong", item: "none" },
};

/** Connects one MCP server for an attempt; `onElicit` asks the person. */
export type McpConnector = (input: {
  name: string;
  spec: McpServerSpec;
  onElicit: ElicitHandler;
}) => Promise<ConnectedMcpServer>;

export interface AiSdkAdapterOptions {
  /** The AI SDK model the host constructed and configured. */
  model: LanguageModel;
  /**
   * Turn a model id into a model, enabling an attempt's `model` override
   * (the host binds provider and key). Without it, overrides are ignored.
   */
  resolveModel?: (modelId: string) => LanguageModel;
  /**
   * Default reasoning effort, mapped onto the provider's native knob
   * (Anthropic thinking budgets, OpenAI reasoning effort). An attempt's
   * `effort` overrides it.
   */
  effort?: AgentEffort;
  /** Host-level instructions, after the built-in ones, before the attempt's. */
  instructions?: string;
  /** Model steps one turn may take before it stops; 150 by default. */
  maxSteps?: number;
  /**
   * How an attempt connects its MCP servers; `@catamorphic/mcp` by
   * default. Hosts that pool connections, and tests, supply their own.
   */
  connectMcp?: McpConnector;
}

/**
 * Host objects for one attempt (`local` of an in-process runner, never
 * serialized). Without `sandbox` the agent has no file or shell tools,
 * only the host's.
 */
export type AiSdkLocal = {
  /** The session's sandbox: file and shell tools run on it. */
  sandbox?: {
    provider: AiSdkSandboxProvider;
    sandboxId: string;
    /** The project folder in the provider's filesystem. */
    workingDirectory: string;
    /** The Environment's budget for one foreground command (ADR 0174). */
    commandBudgetSeconds?: number;
  };
  /**
   * Directories outside the working directory the `read` tool may read
   * (never write): the host's store of files pasted into the chat.
   */
  readableRoots?: readonly string[];
  /**
   * The chat's shell: where the next command starts and the background
   * commands it owns. Kept by the host across attempts, so a command
   * started in one turn is read or stopped in the next; end them with
   * `stopBackgroundCommands` when the chat closes.
   */
  shell?: ShellState;
  /** The person the attempt runs for, for telemetry. */
  userId?: string;
};

/**
 * The built-in agent as a harness adapter (ADR 0198): the Vercel AI SDK
 * tool loop, run in the host's own process (the desktop, the control
 * plane), never in a sandbox bundle. Model calls run in the host; project
 * IO runs on the session's sandbox (`local.sandbox`).
 *
 * Its native thread is the AI SDK message history, stored with Work
 * through `nativeState` one step at a time, so a later turn on another
 * replica or after a restart continues the same history.
 */
export function createAiSdkAdapter(
  options: AiSdkAdapterOptions,
): HarnessAdapter {
  return {
    id: AI_SDK_HARNESS,
    capabilities: () => CAPABILITIES,
    start: (attempt, host, local) =>
      new AiSdkAttempt(options, attempt, host, readLocal(local)).control(),
  };
}

interface SteerInput {
  itemId: string;
  text: string;
  attachments: AgentAttachment[];
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

/** An item still being written. */
interface OpenSegment {
  key: string;
  text: string;
  started: boolean;
}

class AiSdkAttempt {
  /** Interrupts and runner stops. */
  private readonly abort = new AbortController();
  /** A failed state write stops the loop as a failure, not an interrupt. */
  private readonly failure = new AbortController();
  private failureCause: unknown;
  private readonly steers: SteerInput[] = [];
  private accepting = true;
  /** An item was reported: a retry would repeat visible work. */
  private workStarted = false;
  private readonly announced = new Map<string, Deferred>();
  private text: OpenSegment | undefined;
  private readonly reasoning = new Map<string, OpenSegment>();
  private readonly toolItems = new Map<
    string,
    { key: string | null; meta: ToolMeta | undefined }
  >();
  private segments = 0;
  private requests = 0;
  private readonly usage = new UsageTally();
  private readonly model: LanguageModel;
  private readonly modelId: string | undefined;
  private readonly workingDirectory: string;
  private readonly threadRef: NativeRef;
  private readonly turnRef: NativeRef;

  constructor(
    private readonly options: AiSdkAdapterOptions,
    private readonly attempt: AttemptStart,
    private readonly host: AttemptHost,
    private readonly local: AiSdkLocal,
  ) {
    this.model =
      attempt.model && options.resolveModel
        ? options.resolveModel(attempt.model)
        : options.model;
    this.modelId = modelIdOf(this.model);
    this.workingDirectory =
      local.sandbox?.workingDirectory ?? attempt.workingDirectory;
    this.threadRef =
      attempt.thread.mode === "resume" || attempt.thread.mode === "restore"
        ? attempt.thread.nativeRef
        : { id: attempt.thread.providerThreadId, strength: "strong" };
    // The attempt is the native turn: a fork or retry through it names it.
    this.turnRef = { id: attempt.attemptId, strength: "strong" };
    if (host.signal.aborted) this.abort.abort();
    else
      host.signal.addEventListener("abort", () => this.abort.abort(), {
        once: true,
      });
  }

  control(): AttemptControl {
    return {
      steer: async (input) => {
        if (!this.accepting || this.abort.signal.aborted) return false;
        this.steers.push(input);
        return true;
      },
      interrupt: () => this.abort.abort(),
      finished: this.run(),
    };
  }

  private emit(event: HarnessEvent): void {
    if (event.type === "item.started") this.workStarted = true;
    this.host.emit(event);
  }

  private async run(): Promise<void> {
    this.emit({ type: "thread", ref: this.threadRef });
    const telemetry = agentTelemetry({
      model: this.model,
      sessionId: this.attempt.sessionId,
      projectId: this.attempt.projectId,
      turnId: this.attempt.turnId,
      ...(this.local.userId ? { userId: this.local.userId } : {}),
    });
    let servers = new Map<string, ConnectedMcpServer>();
    let turnStored = false;
    let status: "completed" | "failed" | "interrupted" = "completed";
    let error: TurnError | undefined;
    try {
      const folded = await this.history();
      this.emit({ type: "turn.started", ref: this.turnRef });
      const turn = this.turnInput(folded);
      await this.append([turn.entry]);
      turnStored = true;
      servers = await this.connectMcp();
      await this.loop({
        messages: turn.messages,
        tools: this.tools(servers),
        telemetry,
      });
      if (this.abort.signal.aborted) status = "interrupted";
    } catch (cause) {
      if (this.abort.signal.aborted) status = "interrupted";
      else {
        status = "failed";
        const failed = this.failure.signal.aborted ? this.failureCause : cause;
        telemetry.fail(failed);
        const classified = classifyModelError(failed);
        error = {
          message: classified.message,
          ...(classified.kind ? { kind: classified.kind } : {}),
          ...(classified.providerRejected && !this.workStarted
            ? { retrySafe: true }
            : {}),
        };
      }
    }
    this.accepting = false;
    this.settleAnnounced();
    this.closeOpenItems(status);
    telemetry.finish({ cancelled: status === "interrupted" });
    const usage = this.usage.toUsage(this.attempt.model ?? this.modelId);
    if (usage) this.emit({ type: "usage", usage });
    if (turnStored)
      await this.append([
        { v: 1, kind: "turn_end", ref: this.turnRef.id, status },
      ]).catch((cause: unknown) =>
        this.emit({
          type: "diagnostic",
          level: "warn",
          message: `The end of this turn was not stored: ${errorMessage(cause)}`,
        }),
      );
    this.emit({
      type: "turn.completed",
      status,
      ...(error ? { error } : {}),
      ...(turnStored ? { ref: this.turnRef } : {}),
    });
    await Promise.all(
      [...servers.values()].map((server) => server.close().catch(() => {})),
    );
  }

  // -------------------------------------------------------------------------
  // The native thread

  /** The history this attempt continues, from the stored thread. */
  private async history(): Promise<FoldedThread> {
    const thread = this.attempt.thread;
    const sanitize = this.attempt.options.sanitizeReasoning === true;
    const fold = (entries: readonly ThreadEntry[]) =>
      foldThread({
        entries,
        ...((this.attempt.model ?? this.modelId)
          ? { model: this.attempt.model ?? this.modelId }
          : {}),
        sanitize,
      });
    if (thread.mode === "fresh") return { messages: [] };
    if (thread.mode === "fork") {
      // A fork attempt that ran before already copied its source.
      const own = await this.load();
      if (own && own.length > 0) return fold(own);
      const source = await this.load(thread.source.id);
      if (!source)
        throw new Error("The conversation to fork from is not stored.");
      const through = thread.throughTurnRef
        ? entriesThroughTurn(source, thread.throughTurnRef.id)
        : source;
      if (!through)
        throw new Error(
          "The turn to fork from is not in the stored conversation.",
        );
      // The fork's thread starts as a copy, so it resumes anywhere too.
      await this.append(through);
      return fold(through);
    }
    const entries = await this.load();
    if (!entries)
      throw new Error("This conversation's stored history is missing.");
    return fold(entries);
  }

  /** The turn's opening messages and the entry that records them. */
  private turnInput(folded: FoldedThread): {
    messages: ModelMessage[];
    entry: ThreadEntry;
  } {
    const input = this.attempt.input;
    if (input) {
      const opening: ModelMessage[] = [
        // Turn context arrives as a system message beside the prompt,
        // never inside the person's words (ADR 0152).
        ...(this.attempt.context.trim()
          ? [{ role: "system" as const, content: this.attempt.context }]
          : []),
        userMessage(input),
      ];
      return {
        messages: [...folded.messages, ...opening],
        entry: { v: 1, kind: "turn", ref: this.turnRef.id, input: opening },
      };
    }
    // A native retry re-runs the last turn on the history as it stands:
    // a failed turn continues after its finished steps; a final answer is
    // replaced.
    const end = folded.lastTurnInputEnd;
    if (end === undefined)
      throw new Error("There is no earlier turn to retry.");
    const messages = [...folded.messages];
    let drop = 0;
    while (messages.length > end && messages.at(-1)?.role === "assistant") {
      messages.pop();
      drop += 1;
    }
    return {
      messages,
      entry: {
        v: 1,
        kind: "turn",
        ref: this.turnRef.id,
        input: [],
        ...(drop ? { drop } : {}),
      },
    };
  }

  private async load(thread?: string): Promise<ThreadEntry[] | null> {
    const entries = await untilAborted(
      this.host.nativeState.load(thread ? { thread } : {}),
      this.host.signal,
    );
    return entries ? parseThreadEntries(entries) : null;
  }

  /** Store entries; the runner sends a large append as several calls. */
  private async append(entries: readonly ThreadEntry[]): Promise<void> {
    if (this.host.signal.aborted) return;
    const stored = entries.flatMap(storedEntries);
    if (stored.length === 0) return;
    await untilAborted(
      this.host.nativeState.append({ entries: stored }),
      this.host.signal,
    );
  }

  // -------------------------------------------------------------------------
  // The tool loop

  private instructions(): string {
    const plugins = this.attempt.plugins.length
      ? [
          "Plugins installed for you (read their files with the read tool):",
          ...this.attempt.plugins.map(
            (plugin) => `- ${plugin.name}: ${plugin.path}`,
          ),
        ].join("\n")
      : undefined;
    return [
      DEFAULT_INSTRUCTIONS,
      this.options.instructions,
      plugins,
      this.attempt.systemPrompt,
    ]
      .filter((part): part is string => Boolean(part?.trim()))
      .join("\n\n");
  }

  private async loop(input: {
    messages: ModelMessage[];
    tools: Record<string, Tool>;
    telemetry: ReturnType<typeof agentTelemetry>;
  }): Promise<void> {
    let messages = input.messages;
    let stepsLeft = this.options.maxSteps ?? DEFAULT_MAX_STEPS;
    const effort = this.attempt.effort ?? this.options.effort;
    const signal = AbortSignal.any([this.abort.signal, this.failure.signal]);
    for (;;) {
      let prepared = messages;
      let inserted: ModelMessage[] = [];
      const agent = new ToolLoopAgent({
        telemetry: input.telemetry.settings,
        model: this.model,
        instructions: this.instructions(),
        allowSystemInMessages: true,
        tools: input.tools,
        // Steered input joins the turn before the next model step.
        prepareStep: ({ messages: stepMessages }) => {
          const fresh = this.steers.splice(0);
          inserted = fresh.map(userMessage);
          prepared = [...stepMessages, ...inserted];
          if (fresh.length > 0)
            this.emit({
              type: "input.consumed",
              itemIds: fresh.map((steer) => steer.itemId),
            });
          return { messages: prepared };
        },
        onStepFinish: async (step) => {
          stepsLeft -= 1;
          messages = [...prepared, ...step.response.messages];
          const written = [...inserted, ...step.response.messages];
          inserted = [];
          try {
            await this.append([
              {
                v: 1,
                kind: "step",
                ...(this.modelId ? { model: this.modelId } : {}),
                messages: written,
              },
            ]);
          } catch (cause) {
            this.failureCause = cause;
            this.failure.abort();
          }
        },
        stopWhen: stepCountIs(Math.max(1, stepsLeft)),
        ...(effort ? { providerOptions: effortProviderOptions(effort) } : {}),
      });
      const result = await input.telemetry.run(() =>
        agent.stream({ messages, abortSignal: signal }),
      );
      try {
        for await (const part of result.stream) this.onPart(part);
      } finally {
        this.closeText();
        this.settleAnnounced();
      }
      if (this.failure.signal.aborted) throw this.failureCause;
      if (this.abort.signal.aborted) return;
      // A steer that arrived during the last step starts one more round.
      if (this.steers.length === 0 || stepsLeft <= 0) {
        this.accepting = false;
        return;
      }
    }
  }

  private tools(servers: ReadonlyMap<string, ConnectedMcpServer>) {
    const sets: ToolSetWithMeta[] = [];
    const sandbox = this.local.sandbox;
    if (sandbox)
      sets.push(
        workspaceTools({
          provider: sandbox.provider,
          sandboxId: sandbox.sandboxId,
          workingDirectory: this.workingDirectory,
          readableRoots: [
            ...(this.local.readableRoots ?? []),
            ...this.attempt.plugins.map((plugin) => plugin.path),
          ],
          shell: this.local.shell ?? {},
          ...(sandbox.commandBudgetSeconds
            ? { budgetSeconds: sandbox.commandBudgetSeconds }
            : {}),
        }),
      );
    sets.push(
      conversationTools({ ask: (args) => this.askUser(args) }),
      hostTools({
        descriptors: this.attempt.hostTools,
        call: (args) => this.callHostTool(args),
      }),
    );
    // Earlier sets win: a host or MCP tool never shadows a built-in.
    const tools: Record<string, Tool> = {};
    const meta = new Map<string, ToolMeta>();
    const add = (set: ToolSetWithMeta) => {
      for (const [name, entry] of Object.entries(set.tools)) {
        if (Object.hasOwn(tools, name)) continue;
        tools[name] = this.announcedFirst(entry);
        const info = set.meta.get(name);
        if (info) meta.set(name, info);
      }
    };
    for (const set of sets) add(set);
    add(
      mcpTools({
        servers,
        taken: tools,
        authorize: (args) => this.authorizeMcp(args),
      }),
    );
    this.toolMeta = meta;
    return tools;
  }

  private toolMeta = new Map<string, ToolMeta>();

  /**
   * A tool runs only after its call was reported: the text before it, its
   * item, then whatever it asks the host, in that order.
   */
  private announcedFirst(entry: Tool): Tool {
    const execute = entry.execute;
    if (!execute) return entry;
    return {
      ...entry,
      execute: async (args, options) => {
        await this.announcement(options.toolCallId).promise;
        options.abortSignal?.throwIfAborted();
        return execute(args, options);
      },
    };
  }

  private announcement(toolCallId: string): Deferred {
    let entry = this.announced.get(toolCallId);
    if (!entry) {
      let resolve = () => {};
      const promise = new Promise<void>((done) => {
        resolve = done;
      });
      entry = { promise, resolve };
      this.announced.set(toolCallId, entry);
    }
    return entry;
  }

  private settleAnnounced(): void {
    for (const entry of this.announced.values()) entry.resolve();
  }

  // -------------------------------------------------------------------------
  // Stream parts → harness events

  private onPart(part: TextStreamPart<Record<string, Tool>>): void {
    switch (part.type) {
      case "text-delta":
        this.textDelta(part.text);
        return;
      case "reasoning-start":
        this.closeText();
        this.reasoningSegment(part.id);
        return;
      case "reasoning-delta":
        this.reasoningDelta(part.id, part.text);
        return;
      case "reasoning-end":
        this.reasoningEnd(part.id);
        return;
      case "tool-input-start":
        this.closeText();
        return;
      case "tool-call":
        this.closeText();
        this.toolCall({
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          input: part.input,
        });
        this.announcement(part.toolCallId).resolve();
        return;
      case "tool-result":
        this.toolResult(part.toolCallId, part.output);
        return;
      case "tool-error":
        this.toolFailed(part.toolCallId, errorMessage(part.error));
        return;
      case "tool-output-denied":
        this.toolFailed(part.toolCallId, "The tool call was denied.");
        return;
      case "finish-step":
        this.closeText();
        this.usage.add(part.usage);
        return;
      case "error":
        throw part.error;
      default:
        return;
    }
  }

  private textDelta(delta: string): void {
    this.text ??= {
      key: `text:${++this.segments}`,
      text: "",
      started: false,
    };
    const segment = this.text;
    segment.text += delta;
    if (!segment.started) {
      // Whitespace before the first word starts nothing.
      if (!segment.text.trim()) return;
      segment.started = true;
      this.emit({
        type: "item.started",
        key: segment.key,
        item: { kind: "assistant_message", text: "", agentId: null },
      });
      this.emit({
        type: "item.delta",
        key: segment.key,
        field: "text",
        text: segment.text,
      });
      return;
    }
    this.emit({
      type: "item.delta",
      key: segment.key,
      field: "text",
      text: delta,
    });
  }

  private closeText(): void {
    const segment = this.text;
    this.text = undefined;
    if (!segment?.started) return;
    this.emit({
      type: "item.completed",
      key: segment.key,
      status: "completed",
      item: { text: segment.text },
    });
  }

  private reasoningSegment(id: string): OpenSegment {
    let segment = this.reasoning.get(id);
    if (!segment) {
      segment = {
        key: `reasoning:${++this.segments}`,
        text: "",
        started: false,
      };
      this.reasoning.set(id, segment);
    }
    return segment;
  }

  private reasoningDelta(id: string, delta: string): void {
    const segment = this.reasoningSegment(id);
    segment.text += delta;
    if (!segment.started) {
      // Providers stream empty reasoning beside encrypted content.
      if (!segment.text.trim()) return;
      segment.started = true;
      this.emit({
        type: "item.started",
        key: segment.key,
        item: { kind: "reasoning", text: "" },
      });
      this.emit({
        type: "item.delta",
        key: segment.key,
        field: "text",
        text: segment.text,
      });
      return;
    }
    this.emit({
      type: "item.delta",
      key: segment.key,
      field: "text",
      text: delta,
    });
  }

  private reasoningEnd(id: string): void {
    const segment = this.reasoning.get(id);
    this.reasoning.delete(id);
    if (!segment?.started) return;
    this.emit({
      type: "item.completed",
      key: segment.key,
      status: "completed",
      item: { text: segment.text },
    });
    // Reasoning summaries open with a bold heading: the live status.
    const heading = reasoningHeading(segment.text);
    if (heading) this.emit({ type: "status", text: heading });
  }

  private toolCall(call: {
    toolCallId: string;
    toolName: string;
    input: unknown;
  }): void {
    const meta = this.toolMeta.get(call.toolName);
    const values = isRecord(call.input) ? call.input : {};
    const key = `tool:${call.toolCallId}`;
    const description =
      typeof values.description === "string" && values.description
        ? values.description
        : null;
    if (meta?.kind === "title") {
      if (typeof values.title === "string" && values.title.trim())
        this.emit({ type: "title", text: values.title.trim() });
      this.toolItems.set(call.toolCallId, { key: null, meta });
      return;
    }
    // A question is its runtime request, not a tool call.
    if (meta?.kind === "ask") {
      this.toolItems.set(call.toolCallId, { key: null, meta });
      return;
    }
    this.toolItems.set(call.toolCallId, { key, meta });
    if (meta?.kind === "command") {
      this.emit({
        type: "item.started",
        key,
        item: {
          kind: "command",
          command: typeof values.command === "string" ? values.command : "",
          description,
          output: "",
          exitCode: null,
        },
      });
      return;
    }
    if (meta?.kind === "file") {
      const filePath = typeof values.path === "string" ? values.path : "";
      this.emit({
        type: "item.started",
        key,
        item: {
          kind: "file_change",
          path: this.projectRelative(filePath),
          change: meta.change,
          previousPath: null,
        },
      });
      return;
    }
    this.emit({
      type: "item.started",
      key,
      item: {
        kind: "tool_call",
        tool: call.toolName,
        server: meta?.kind === "tool" ? meta.server : null,
        description,
        input: toJsonValue(call.input),
        result: null,
        error: null,
      },
    });
  }

  private projectRelative(filePath: string): string {
    try {
      return path.posix.relative(
        this.workingDirectory,
        resolveProjectPath(this.workingDirectory, filePath),
      );
    } catch {
      return filePath;
    }
  }

  private toolResult(toolCallId: string, output: unknown): void {
    const entry = this.toolItems.get(toolCallId);
    this.toolItems.delete(toolCallId);
    if (!entry?.key) return;
    if (entry.meta?.kind === "command") {
      const shell = shellResultSchema.safeParse(output);
      this.emit({
        type: "item.completed",
        key: entry.key,
        status: "completed",
        item: shell.success
          ? { output: shell.data.output, exitCode: shell.data.exitCode }
          : { output: typeof output === "string" ? output : "" },
      });
      return;
    }
    if (entry.meta?.kind === "file") {
      this.emit({
        type: "item.completed",
        key: entry.key,
        status: "completed",
      });
      return;
    }
    const host = parseHostToolResult(output);
    const result = toJsonValue(transcriptToolResult(output));
    if (
      entry.meta?.kind === "tool" &&
      entry.meta.source === "host" &&
      host?.isError
    ) {
      this.emit({
        type: "item.completed",
        key: entry.key,
        status: "failed",
        item: {
          result,
          error: host.content
            .flatMap((part) => (part.type === "text" ? [part.text] : []))
            .join("\n"),
        },
      });
      return;
    }
    this.emit({
      type: "item.completed",
      key: entry.key,
      status: "completed",
      item: { result },
    });
  }

  private toolFailed(toolCallId: string, message: string): void {
    const entry = this.toolItems.get(toolCallId);
    this.toolItems.delete(toolCallId);
    if (!entry?.key) return;
    this.emit({
      type: "item.completed",
      key: entry.key,
      status: "failed",
      item:
        entry.meta?.kind === "command"
          ? { output: message }
          : entry.meta?.kind === "file"
            ? {}
            : { error: message },
    });
  }

  private closeOpenItems(status: "completed" | "failed" | "interrupted"): void {
    this.closeText();
    for (const id of [...this.reasoning.keys()]) this.reasoningEnd(id);
    for (const [toolCallId, entry] of this.toolItems) {
      this.toolItems.delete(toolCallId);
      if (!entry.key) continue;
      this.emit({
        type: "item.completed",
        key: entry.key,
        status: status === "interrupted" ? "cancelled" : "failed",
      });
    }
  }

  // -------------------------------------------------------------------------
  // Host calls and requests

  /** Open a request and wait; an interrupt withdraws it. */
  private async request(key: string, draft: RequestDraft) {
    try {
      return await untilAborted(
        this.host.request(key, draft),
        this.abort.signal,
      );
    } catch (cause) {
      if (this.abort.signal.aborted && !(cause instanceof RequestClosedError))
        this.emit({ type: "request.closed", key, reason: "The turn stopped." });
      throw cause;
    }
  }

  private async askUser(args: {
    questions: Array<{
      question: string;
      header: string;
      multiSelect: boolean;
      options: Array<{ label: string; description: string }>;
    }>;
    blocking: boolean;
    toolCallId: string;
  }): Promise<string> {
    const key = `ask:${args.toolCallId}`;
    const first = args.questions[0];
    const draft: RequestDraft = {
      kind: "question",
      blocking: args.blocking,
      title:
        args.questions.length === 1 && first
          ? first.question
          : `${args.questions.length} questions`,
      origin: { kind: "tool", id: "ask_user", displayName: "Ask User" },
      questions: args.questions,
    };
    if (!args.blocking) {
      // The answer arrives as a message (ADR 0198); nothing waits here.
      this.host.request(key, draft).catch(() => {});
      return "Asked. The answer arrives as a message when the person replies; keep working on what does not depend on it.";
    }
    try {
      const response = await this.request(key, draft);
      if (response.kind !== "question") return "The person did not answer.";
      return args.questions
        .map(
          (question, index) =>
            `${question.question}\nAnswer: ${response.answers[index] ?? "(no answer)"}`,
        )
        .concat(response.answers.slice(args.questions.length))
        .join("\n\n");
    } catch (cause) {
      if (cause instanceof RequestClosedError)
        return `The question was closed without an answer: ${cause.reason}`;
      throw cause;
    }
  }

  private async callHostTool(args: {
    name: string;
    input: unknown;
    toolCallId: string;
  }): Promise<HostToolResult> {
    return untilAborted(
      this.host.callTool({
        name: args.name,
        input: toJsonValue(args.input),
        itemKey: `tool:${args.toolCallId}`,
      }),
      this.abort.signal,
    );
  }

  /** Servers with a policy are decided by it; only `ask` reaches a person. */
  private async authorizeMcp(args: {
    server: string;
    tool: { name: string };
    input: Record<string, unknown>;
    toolCallId: string;
  }): Promise<void> {
    if (!this.attempt.toolPolicies[args.server]) return;
    const verdict = await untilAborted(
      this.host.authorize({
        server: args.server,
        tool: args.tool.name,
        input: toJsonValue(args.input),
        itemKey: `tool:${args.toolCallId}`,
      }),
      this.abort.signal,
    );
    if (!verdict.allowed) throw new Error(verdict.message);
  }

  private async connectMcp(): Promise<Map<string, ConnectedMcpServer>> {
    const connect: McpConnector =
      this.options.connectMcp ??
      (({ spec, onElicit }) => connectMcpServer(spec, { onElicit }));
    const entries = Object.entries(this.attempt.mcpServers);
    const connected = await Promise.all(
      entries.map(async ([name, spec]) => {
        try {
          return await connect({
            name,
            spec,
            onElicit: (request) => this.elicit(name, request),
          });
        } catch (cause) {
          // A broken connector never breaks the chat.
          this.emit({
            type: "diagnostic",
            level: "warn",
            message: `The MCP server "${name}" did not connect: ${errorMessage(cause)}`,
          });
          return undefined;
        }
      }),
    );
    const servers = new Map<string, ConnectedMcpServer>();
    entries.forEach(([name], index) => {
      const server = connected[index];
      if (server) servers.set(name, server);
    });
    return servers;
  }

  /** An MCP server asks the person for input (form or URL). */
  private async elicit(
    server: string,
    request: ElicitRequest,
  ): Promise<ElicitResult> {
    const key = `elicitation:${server}:${++this.requests}`;
    try {
      const response = await this.request(key, {
        kind: "elicitation",
        blocking: true,
        title: `${server} needs your input`,
        description: request.message,
        origin: { kind: "mcp", id: server, displayName: server },
        elicitation: {
          server,
          message: request.message,
          ...(request.mode === "url"
            ? { url: request.url }
            : { schema: elicitationSchema(request.fields) }),
        },
      });
      if (response.kind !== "elicitation") return { action: "cancel" };
      if (response.action === "accept")
        return {
          action: "accept",
          ...(isRecord(response.content) ? { content: response.content } : {}),
        };
      return { action: response.action };
    } catch {
      return { action: "cancel" };
    }
  }
}

const shellResultSchema = z.object({
  exitCode: z.number(),
  output: z.string(),
});

/** An elicitation form's fields as the JSON Schema a request carries. */
function elicitationSchema(
  fields: Extract<ElicitRequest, { mode: "form" }>["fields"],
): { [key: string]: JsonValue } {
  const properties: { [key: string]: JsonValue } = {};
  for (const field of fields) {
    const values = field.options?.map((option) => option.value);
    const base = {
      ...(field.title ? { title: field.title } : {}),
      ...(field.description ? { description: field.description } : {}),
      ...(field.format ? { format: field.format } : {}),
      ...(field.default !== undefined ? { default: field.default } : {}),
    };
    properties[field.name] =
      field.type === "enum"
        ? field.multiSelect
          ? {
              ...base,
              type: "array",
              items: { type: "string", enum: values ?? [] },
            }
          : { ...base, type: "string", enum: values ?? [] }
        : { ...base, type: field.type };
  }
  return {
    type: "object",
    properties,
    required: fields
      .filter((field) => field.required)
      .map((field) => field.name),
  };
}

/**
 * Prose with inline references in place of attachment markers, text
 * attachments as labelled context blocks after it, media as image and file
 * parts beside it.
 */
function userMessage(input: {
  text: string;
  attachments: AgentAttachment[];
}): ModelMessage {
  const text = renderUserMessage(input.text, input.attachments);
  const media = input.attachments.filter(isMediaAttachment);
  if (media.length === 0) return { role: "user", content: text };
  return {
    role: "user",
    content: [
      { type: "text", text },
      ...media.map((attachment) =>
        attachment.kind === "image"
          ? {
              type: "image" as const,
              image: attachment.dataBase64,
              mediaType: attachment.mediaType,
            }
          : {
              type: "file" as const,
              data: attachment.dataBase64,
              mediaType: attachment.mediaType,
              filename: attachment.name,
            },
      ),
    ],
  };
}

/**
 * The normalized effort scale on each provider's native reasoning knob.
 * Both keys are always present: providers ignore options addressed to
 * someone else. Anthropic gets a thinking budget per level; OpenAI's
 * reasoning effort stops at "high", so the top levels clamp to it.
 */
const ANTHROPIC_THINKING_BUDGETS: Record<AgentEffort, number> = {
  low: 0,
  medium: 10_000,
  high: 32_000,
  xhigh: 48_000,
  max: 64_000,
};

function effortProviderOptions(effort: AgentEffort) {
  return {
    anthropic:
      effort === "low"
        ? { thinking: { type: "disabled" } }
        : {
            thinking: {
              type: "enabled",
              budgetTokens: ANTHROPIC_THINKING_BUDGETS[effort],
            },
          },
    openai: {
      reasoningEffort: effort === "xhigh" || effort === "max" ? "high" : effort,
      // Summaries carry the headings the host shows as live status.
      reasoningSummary: "auto",
    },
  };
}

/**
 * A turn's token accounting (ADR 0057), summed over its model steps. The
 * AI SDK's `inputTokens` is the provider's whole prompt; the cached splits
 * live in `inputTokenDetails` when the provider reports them. The context
 * after the turn is the last step's prompt plus what it wrote.
 */
class UsageTally {
  private input = 0;
  private cached = 0;
  private cacheCreation = 0;
  private output = 0;
  private reasoning = 0;
  private context = 0;

  add(usage: LanguageModelUsage): void {
    const input = positiveTokenCount(usage.inputTokens);
    const output = positiveTokenCount(usage.outputTokens);
    this.input += input;
    this.cached += positiveTokenCount(usage.inputTokenDetails?.cacheReadTokens);
    this.cacheCreation += positiveTokenCount(
      usage.inputTokenDetails?.cacheWriteTokens,
    );
    this.output += output;
    this.reasoning += positiveTokenCount(
      usage.outputTokenDetails?.reasoningTokens,
    );
    if (input + output > 0) this.context = input + output;
  }

  toUsage(model: string | undefined): AgentTurnUsage | undefined {
    if (this.input + this.output === 0) return undefined;
    return {
      ...(model ? { model } : {}),
      // Prompt totals include the cached portion; report the uncached
      // remainder so counters never double count.
      inputTokens: Math.max(0, this.input - this.cached - this.cacheCreation),
      cachedInputTokens: this.cached,
      cacheCreationTokens: this.cacheCreation,
      outputTokens: this.output,
      reasoningTokens: Math.min(this.output, this.reasoning),
      ...(this.context ? { contextTokens: this.context } : {}),
    };
  }
}

function modelIdOf(model: LanguageModel): string | undefined {
  return typeof model === "string" ? model : model.modelId;
}

/** Settle with the promise, or reject once the signal aborts. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    promise.catch(() => {});
    return Promise.reject(abortError());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      promise.catch(() => {});
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (cause: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(cause);
      },
    );
  });
}

function abortError(): Error {
  const error = new Error("The turn stopped.");
  error.name = "AbortError";
  return error;
}

/** `local` as this adapter's host objects; a malformed sandbox fails loudly. */
function readLocal(local: Record<string, unknown> | undefined): AiSdkLocal {
  if (!local) return {};
  const sandbox = local.sandbox;
  if (sandbox !== undefined && !isSandboxHandle(sandbox))
    throw new Error(
      "The ai-sdk harness was given a sandbox without a provider, sandbox id and working directory.",
    );
  const roots = local.readableRoots;
  const shell = local.shell;
  return {
    ...(sandbox ? { sandbox } : {}),
    ...(Array.isArray(roots)
      ? {
          readableRoots: roots.filter(
            (root): root is string => typeof root === "string",
          ),
        }
      : {}),
    ...(isShellState(shell) ? { shell } : {}),
    ...(typeof local.userId === "string" ? { userId: local.userId } : {}),
  };
}

function isSandboxHandle(
  value: unknown,
): value is NonNullable<AiSdkLocal["sandbox"]> {
  return (
    isRecord(value) &&
    isRecord(value.provider) &&
    typeof value.provider.executeCommand === "function" &&
    typeof value.provider.uploadFiles === "function" &&
    typeof value.provider.downloadFile === "function" &&
    typeof value.sandboxId === "string" &&
    typeof value.workingDirectory === "string" &&
    (value.commandBudgetSeconds === undefined ||
      typeof value.commandBudgetSeconds === "number")
  );
}

function isShellState(value: unknown): value is ShellState {
  return (
    isRecord(value) &&
    (value.cwd === undefined || typeof value.cwd === "string") &&
    (value.background === undefined || value.background instanceof Map)
  );
}
