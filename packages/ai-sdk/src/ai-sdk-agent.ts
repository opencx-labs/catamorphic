import path from "node:path";
import {
  type ConnectedMcpServer,
  connectMcpServer,
  type ElicitHandler,
  flattenToolResult,
  type McpToolInfo,
} from "@catamorphic/mcp";
import type {
  AgentEffort,
  AgentEvent,
  AgentMcpServerConfig,
  AgentQuestion,
  AgentTurnUsage,
  CodingAgentProvider,
  ExtraTool,
  ExtraToolContext,
  McpServersSource,
  McpToolPolicyLayers,
  ProviderSession,
  SandboxProvider,
  StartSessionOpts,
  ToolPermissionHandler,
  TurnOptions,
} from "@catamorphic/sandbox";
import {
  buildPluginsPreamble,
  isMediaAttachment,
  mergePolicyLayers,
  positiveTokenCount,
  renderUserMessage,
  resolveMcpServers,
  stagedPluginFiles,
  ToolGate,
} from "@catamorphic/sandbox";
import {
  dynamicTool,
  jsonSchema,
  type LanguageModel,
  type ModelMessage,
  stepCountIs,
  type Tool,
  ToolLoopAgent,
  tool,
} from "ai";
import { z } from "zod";

const DEFAULT_INSTRUCTIONS = `You are working in a Catamorphic project — a folder that can hold any kind of work: documents, notes, data, code, automations, apps.
Use the provided tools to inspect and edit the project in your working directory.
Read AGENTS.md and relevant .agents/skills/*/SKILL.md files, when they exist, before making substantial changes.
Keep changes focused, run relevant checks, and do not commit changes.
At the start of a new conversation, once the topic is clear from the first user message, call set_title with a concise conversation title; update it whenever the current title no longer fits the conversation, but not for minor detours.`;
const MAX_TOOL_OUTPUT_LENGTH = 100_000;
const EXA_MCP_URL = "https://mcp.exa.ai/mcp";
const WEBFETCH_MAX_BYTES = 5 * 1024 * 1024;
const WEBFETCH_TIMEOUT_MS = 30_000;

export interface AiSdkCodingAgentOpts {
  /** AI SDK model supplied and configured by the host application. */
  model: LanguageModel;
  /** Provider for the remote development sandbox that contains the project. */
  sandboxProvider: SandboxProvider;
  /** Host-level instructions prepended to every session. */
  instructions?: string;
  /**
   * Default reasoning effort, mapped onto the provider's native knob
   * (Anthropic thinking budgets, OpenAI reasoning effort). Overridable per
   * turn via {@link TurnOptions}.
   */
  effort?: AgentEffort;
  /**
   * Turn a model id into a model instance, enabling per-turn
   * {@link TurnOptions.model} overrides (the host binds provider + key).
   * Without it, per-turn model overrides are ignored.
   */
  resolveModel?: (modelId: string) => LanguageModel;
  /**
   * Host-supplied tools offered beside the built-in set (e.g. the desktop
   * app's workspace tools). Executed with the session's project/session
   * context; a thrown error becomes the tool's error result.
   */
  extraTools?: ExtraTool[];
  /**
   * External MCP servers for this agent. This harness has no CLI to hand
   * them to, so it connects itself (via `@catamorphic/mcp`, stateless
   * protocol preferred) and mounts each server's tools beside the
   * built-ins as `mcp__<server>__<tool>`. Connections are shared across
   * the agent's sessions and a server that fails to connect is skipped —
   * a broken connector must never break the chat.
   *
   * A getter is read live at every session start and turn: a server whose
   * config changed (a rotated OAuth token, a renewed header) is
   * reconnected in place, under the same tool names, so running sessions
   * carry on with the fresh credential — no provider rebuild.
   */
  mcpServers?: McpServersSource;
  /**
   * Session-scoped MCP servers, resolved from the session's project —
   * how a host mounts per-project surfaces (e.g. Catamorphic's workflow
   * tools endpoint) beside the agent-wide {@link mcpServers}. Connected
   * fresh per session (so a new chat sees the project's current tool
   * roster, and a transient failure never poisons later sessions) and
   * closed when the session is disposed.
   */
  mcpServersForSession?: (
    context: ExtraToolContext,
  ) => Record<string, AgentMcpServerConfig>;
  /**
   * How to answer MCP `elicitation/create` (form/URL) from those servers —
   * the host renders it to the user. Also drives MRTR auto-fulfilment on
   * the stateless era. Omit and servers see no elicitation capability.
   */
  onElicit?: ElicitHandler;
  /**
   * Per-server tool permissions (layers: connection ceiling, agent
   * narrowing). A tool resolving to `deny` fails with a message the model
   * can read; `ask` raises {@link onToolPermission}. Servers without an
   * entry run unrestricted (session-scoped project surfaces, hosts that
   * don't police tools). See @catamorphic/sandbox tool-policy.
   */
  mcpPolicies?: McpPolicySource;
  /**
   * How to ask the user about an `ask` tool. Omitted = there is nobody to
   * ask, so `ask` fails closed (the tool is refused, with a message).
   */
  onToolPermission?: ToolPermissionHandler;
}

/**
 * Policies as a value, or as a getter the harness consults on every call —
 * so a permission edit applies to a live conversation without the host
 * rebuilding the provider (which would drop in-memory sessions).
 */
export type McpPolicySource =
  | Record<string, McpToolPolicyLayers>
  | (() => Record<string, McpToolPolicyLayers>);

interface AiSdkSessionState {
  instructions: string;
  tools: ReturnType<typeof createTools>;
  messages: ModelMessage[];
  sandboxId: string;
  workingDirectory: string;
  running: boolean;
  /** Session-scoped MCP connections, closed when the session is disposed. */
  scopedMcp: ConnectedMcpServer[];
  /** Aborts the in-flight turn (interrupt()); cleared when the turn ends. */
  abort?: AbortController;
  /** Set when the turn ended on an ask_user call awaiting the user's answer. */
  pendingAsk?: { toolCallId: string };
  /**
   * The caller's tool-policy layers (ADR 0055), replaced on every turn
   * that carries them; the gate reads them live so a revoked grant applies
   * to the next tool call.
   */
  callerPolicies?: Record<string, McpToolPolicyLayers>;
}

/**
 * Minimal in-process coding agent built on Vercel AI SDK's ToolLoopAgent.
 * Model calls run in the host while all project IO runs in the dev sandbox.
 */
export class AiSdkCodingAgent implements CodingAgentProvider {
  readonly name = "ai-sdk";
  private readonly sessions = new Map<string, AiSdkSessionState>();
  /** The agent-wide MCP connections, kept in step with the live source. */
  private readonly mcp: McpPool;

  constructor(private readonly opts: AiSdkCodingAgentOpts) {
    this.mcp = new McpPool(
      () => resolveMcpServers(opts.mcpServers),
      opts.onElicit,
    );
  }

  /**
   * Connect one session-scoped server. Failures are skipped with a warning
   * and NOT cached, mirroring the agent-wide set's tolerance while letting
   * the next session retry — a broken per-project endpoint must never
   * break the chat, and a transient one must not stay broken.
   */
  private async connectScopedServer(
    name: string,
    config: AgentMcpServerConfig,
  ): Promise<ConnectedMcpServer | undefined> {
    try {
      return await connectMcpServer(
        config,
        this.opts.onElicit ? { onElicit: this.opts.onElicit } : undefined,
      );
    } catch (cause) {
      console.warn(
        `[ai-sdk] session MCP server "${name}" failed to connect:`,
        cause,
      );
      return undefined;
    }
  }

  /**
   * Close MCP connections (stdio child processes, HTTP sessions). Called
   * by hosts when they drop this provider instance for a rebuilt one.
   */
  async closeMcp(): Promise<void> {
    // Session-scoped connections of sessions the host never disposed.
    const scoped = [...this.sessions.values()].flatMap((state) => {
      const servers = state.scopedMcp;
      state.scopedMcp = [];
      return servers;
    });
    await Promise.all(scoped.map((server) => server.close().catch(() => {})));
    await this.mcp.close();
  }

  /**
   * The permission gate MCP tools run through — the shared sandbox
   * `ToolGate` (one decision, wording, remember and abort semantics for
   * every harness), fed the provider's live layers merged with the
   * session's caller layers (ADR 0055). "Always allow" answers live for
   * this provider's lifetime (the host persists them for the next one).
   */
  private toolGate(
    callerPolicies: () => Record<string, McpToolPolicyLayers> | undefined,
  ): McpToolGate {
    const gate = new ToolGate(this.opts.onToolPermission);
    const source = this.opts.mcpPolicies ?? {};
    return async (server, tool, input, sessionId, abortSignal) => {
      const own = typeof source === "function" ? source() : source;
      const policies = mergePolicyLayers(own, callerPolicies());
      const verdict = await gate.decide({
        server,
        tool: tool.name,
        input,
        layers: policies?.[server],
        ...(tool.annotations ? { annotations: tool.annotations } : {}),
        ...(tool.description !== undefined
          ? { description: tool.description }
          : {}),
        ...(sessionId ? { sessionId } : {}),
        ...(abortSignal ? { abortSignal } : {}),
      });
      if (!verdict.allowed) throw new Error(verdict.message);
    };
  }

  async startSession(opts: StartSessionOpts): Promise<ProviderSession> {
    const pluginFiles = stagedPluginFiles(opts.attachedPlugins);
    if (Object.keys(pluginFiles).length > 0) {
      await this.opts.sandboxProvider.uploadFiles(
        opts.sandboxId,
        pluginFiles,
        opts.workingDirectory,
      );
    }

    const instructions = [
      DEFAULT_INSTRUCTIONS,
      this.opts.instructions,
      buildPluginsPreamble(opts.attachedPlugins),
      opts.systemPrompt,
    ]
      .filter((part): part is string => Boolean(part))
      .join("\n\n");
    const providerSessionId = crypto.randomUUID();

    // The gate reads the session's caller layers by id: they exist only
    // once the state below is stored, and change per turn.
    const gate = this.toolGate(
      () => this.sessions.get(providerSessionId)?.callerPolicies,
    );
    const mcpTools = buildMcpTools(
      await this.mcp.sync(),
      this.mcp,
      gate,
      opts.sessionId,
    );

    // Session-scoped servers (per-project surfaces) connect fresh per
    // session and mount beside the agent-wide set; on a name clash the
    // session-scoped server wins. Closed when the session is disposed.
    const scopedConfigs = this.opts.mcpServersForSession?.({
      projectId: opts.projectId,
      sessionId: opts.sessionId,
      ...(opts.caller ? { caller: opts.caller } : {}),
    });
    const scopedMcp: ConnectedMcpServer[] = [];
    if (scopedConfigs) {
      const scoped = new Map<string, ConnectedMcpServer>();
      await Promise.all(
        Object.entries(scopedConfigs).map(async ([name, config]) => {
          const server = await this.connectScopedServer(name, config);
          if (server) {
            scoped.set(name, server);
            scopedMcp.push(server);
          }
        }),
      );
      Object.assign(
        mcpTools,
        buildMcpTools(scoped, scoped, gate, opts.sessionId),
      );
    }

    this.sessions.set(providerSessionId, {
      instructions,
      tools: createTools(
        {
          provider: this.opts.sandboxProvider,
          sandboxId: opts.sandboxId,
          workingDirectory: opts.workingDirectory,
        },
        this.opts.extraTools ?? [],
        {
          projectId: opts.projectId,
          sessionId: opts.sessionId,
          ...(opts.caller ? { caller: opts.caller } : {}),
        },
        mcpTools,
      ),
      // Resurrected sessions (host restart, provider rebuild after a
      // credential change) start from the host's persisted transcript.
      messages: (opts.history ?? []).map(
        (turn): ModelMessage => ({ role: turn.role, content: turn.content }),
      ),
      sandboxId: opts.sandboxId,
      workingDirectory: opts.workingDirectory,
      running: false,
      scopedMcp,
      ...(opts.toolPolicies ? { callerPolicies: opts.toolPolicies } : {}),
    });

    return {
      providerSessionId,
      sessionId: opts.sessionId,
      projectId: opts.projectId,
      sandboxId: opts.sandboxId,
      workingDirectory: opts.workingDirectory,
    };
  }

  hasSession(providerSessionId: string): boolean {
    return this.sessions.has(providerSessionId);
  }

  async *sendMessage(
    session: ProviderSession,
    message: string,
    opts?: TurnOptions,
  ): AsyncIterable<AgentEvent> {
    const state = session.providerSessionId
      ? this.sessions.get(session.providerSessionId)
      : undefined;
    if (!state) {
      yield {
        type: "error",
        content: "Session not found (host restarted?); start a new session",
      };
      return;
    }
    if (state.running) {
      yield { type: "error", content: "A message is already running" };
      return;
    }
    if (opts?.toolPolicies) state.callerPolicies = opts.toolPolicies;
    // Credentials may have rotated since the last turn: reconnect the
    // servers whose config changed, in place, before the model runs.
    await this.mcp.sync();
    // Answers to a pending ask_user call resume the tool loop as the tool's
    // result; anything else is a regular user message.
    const pendingAsk = state.pendingAsk;
    state.pendingAsk = undefined;
    const requestMessages: ModelMessage[] = [
      ...state.messages,
      pendingAsk
        ? {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: pendingAsk.toolCallId,
                toolName: "ask_user",
                output: { type: "text", value: message },
              },
            ],
          }
        : userMessage(message, opts?.attachments ?? []),
    ];
    yield* this.runTurn(state, requestMessages, opts);
  }

  /**
   * Re-run the turn on the history as it stands (the failed turn's user
   * message is already the tail — sendMessage appends before streaming).
   * `sanitizeReasoning` drops reasoning parts from prior assistant turns:
   * they carry model-specific signatures that a different model rejects.
   */
  async *retryTurn(
    session: ProviderSession,
    opts?: TurnOptions & { sanitizeReasoning?: boolean },
  ): AsyncIterable<AgentEvent> {
    const state = session.providerSessionId
      ? this.sessions.get(session.providerSessionId)
      : undefined;
    if (!state) {
      yield {
        type: "error",
        content: "Session not found (host restarted?); start a new session",
      };
      return;
    }
    if (state.running) {
      yield { type: "error", content: "A message is already running" };
      return;
    }
    if (opts?.toolPolicies) state.callerPolicies = opts.toolPolicies;
    if (state.messages.length === 0) {
      // Defensive: hosts route retries on a freshly restored session
      // through sendMessage (the restored history excludes the failed
      // turn), so this should be unreachable — but if it ever surfaces,
      // it must tell the user what to do, not "Nothing to retry yet".
      yield {
        type: "error",
        content:
          "This conversation was restored and the failed turn can't be " +
          "replayed automatically. Send your message again to continue.",
      };
      return;
    }
    if (opts?.sanitizeReasoning) {
      state.messages = stripReasoningParts(state.messages);
    }
    yield* this.runTurn(state, state.messages, opts);
  }

  interrupt(providerSessionId: string): void {
    this.sessions.get(providerSessionId)?.abort?.abort();
  }

  private async *runTurn(
    state: AiSdkSessionState,
    requestMessages: ModelMessage[],
    opts?: TurnOptions,
  ): AsyncIterable<AgentEvent> {
    // The agent object is stateless (history lives in state.messages), so
    // each turn builds one with that turn's effort and model — a model
    // switch mid-conversation keeps the session, because the session IS
    // the message history.
    const effort = opts?.effort ?? this.opts.effort;
    const model =
      opts?.model && this.opts.resolveModel
        ? this.opts.resolveModel(opts.model)
        : this.opts.model;
    const agent = new ToolLoopAgent({
      model,
      instructions: state.instructions,
      tools: state.tools,
      // The AI SDK's default stop condition is stepCountIs(20) — far too
      // small for real coding turns (scaffold a workspace, build, fix,
      // rebuild easily exceeds it) and it ends the turn SILENTLY mid-work.
      // Interruption stays available via abort; the cap is a runaway guard.
      stopWhen: stepCountIs(150),
      ...(effort ? { providerOptions: effortProviderOptions(effort) } : {}),
    });

    state.running = true;
    state.abort = new AbortController();
    state.messages = requestMessages;
    let text = "";
    let askedToolCallId: string | undefined;
    let askedQuestions: AgentQuestion[] | undefined;
    // MCP tool calls get a second, cumulative event once their result
    // lands — the result payload is what an MCP Apps view renders.
    const pendingMcpCalls = new Map<string, { name: string; input: unknown }>();

    try {
      const result = await agent.stream({
        messages: requestMessages,
        abortSignal: state.abort.signal,
      });
      for await (const part of result.stream) {
        if (part.type === "text-delta") {
          text += part.text;
          continue;
        }
        if (part.type === "tool-call") {
          if (text.trim().length > 0) {
            yield { type: "text", content: text };
            text = "";
          }
          if (part.toolName === "ask_user") {
            askedToolCallId = part.toolCallId;
            askedQuestions = parseAskUserInput(part.input);
            continue;
          }
          if (part.toolName.startsWith("mcp__")) {
            pendingMcpCalls.set(part.toolCallId, {
              name: part.toolName,
              input: part.input,
            });
            yield {
              ...mapToolCall(part.toolName, part.input),
              toolUseId: part.toolCallId,
            };
            continue;
          }
          yield mapToolCall(part.toolName, part.input);
          continue;
        }
        if (part.type === "tool-result") {
          const pending = pendingMcpCalls.get(part.toolCallId);
          if (pending) {
            pendingMcpCalls.delete(part.toolCallId);
            yield {
              ...mapToolCall(pending.name, pending.input),
              toolUseId: part.toolCallId,
              toolResult:
                (part as { output?: unknown }).output ??
                (part as { result?: unknown }).result,
            };
          }
          continue;
        }
        if (part.type === "tool-error") {
          yield {
            type: "error",
            content: `Tool ${part.toolName} failed: ${errorMessage(part.error)}`,
          };
          continue;
        }
        if (part.type === "error") {
          throw part.error;
        }
      }

      if (text.trim().length > 0) {
        yield { type: "text", content: text };
      }
      state.messages = [...requestMessages, ...(await result.responseMessages)];
      const usage = turnUsageFromAiSdk(
        await result.totalUsage,
        opts?.model ??
          (typeof model === "object" && model !== null && "modelId" in model
            ? String((model as { modelId: unknown }).modelId)
            : typeof model === "string"
              ? model
              : undefined),
      );
      if (usage) {
        yield { type: "usage", usage };
      }
      if (askedToolCallId && askedQuestions) {
        state.pendingAsk = { toolCallId: askedToolCallId };
        yield { type: "question", questions: askedQuestions };
      }
      yield { type: "done" };
    } catch (error) {
      if (text.trim().length > 0) {
        yield { type: "text", content: text };
      }
      if (state.abort?.signal.aborted) {
        // Interrupted by the host (user takes over) — not a failure to
        // classify or retry; the partial text above is kept.
        yield { type: "error", content: "Interrupted." };
      } else {
        yield { type: "error", content: errorMessage(error) };
      }
    } finally {
      state.running = false;
      state.abort = undefined;
    }
  }

  async dispose(session: ProviderSession): Promise<void> {
    if (!session.providerSessionId) return;
    const state = this.sessions.get(session.providerSessionId);
    this.sessions.delete(session.providerSessionId);
    if (state) {
      await Promise.all(
        state.scopedMcp.map((server) => server.close().catch(() => {})),
      );
      state.scopedMcp = [];
    }
  }
}

/**
 * User message: inline attachment markers become numbered references, text
 * attachments (pastes, selections, URLs, paths, tabs) render as labelled
 * context blocks after the prose; media attachments become image/file parts
 * beside it.
 */
function userMessage(
  message: string,
  attachments: NonNullable<TurnOptions["attachments"]>,
): ModelMessage {
  const text = renderUserMessage(message, attachments);
  const media = attachments.filter(isMediaAttachment);
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
 * Drop reasoning parts from assistant history. Reasoning output is signed
 * by the model that produced it; after a mid-conversation model switch the
 * new model rejects those signatures ("encrypted reasoning" errors).
 */
function stripReasoningParts(messages: ModelMessage[]): ModelMessage[] {
  return messages.map((message) => {
    if (message.role !== "assistant" || !Array.isArray(message.content)) {
      return message;
    }
    const content = message.content.filter((part) => part.type !== "reasoning");
    return { ...message, content };
  });
}

/**
 * Map the normalized effort scale onto each provider's native reasoning
 * knob. Both keys are always present — providers ignore options addressed
 * to someone else, so the same object works for Anthropic and OpenAI models.
 * Anthropic gets a thinking budget per level; OpenAI's reasoning effort
 * stops at "high", so the top levels clamp to it.
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
    },
  };
}

interface ToolContext {
  provider: SandboxProvider;
  sandboxId: string;
  workingDirectory: string;
}

/**
 * The agent-wide MCP connections, reconciled against a live source: each
 * `sync` connects servers that are new or whose config changed (closing
 * the stale connection — a rotated token reconnects in place), closes
 * servers that left, and leaves the rest alone. Failures are skipped with
 * a warning and retried on the next sync, never cached — a broken
 * connector must not break the chat, and a transient one must not stay
 * broken. Syncs are serialized so two sessions starting at once share one
 * connect.
 */
class McpPool {
  private readonly entries = new Map<
    string,
    { digest: string; server: ConnectedMcpServer }
  >();
  private inflight: Promise<Map<string, ConnectedMcpServer>> | undefined;

  constructor(
    private readonly source: () => Record<string, AgentMcpServerConfig>,
    private readonly onElicit: ElicitHandler | undefined,
  ) {}

  get(name: string): ConnectedMcpServer | undefined {
    return this.entries.get(name)?.server;
  }

  sync(): Promise<Map<string, ConnectedMcpServer>> {
    this.inflight ??= this.reconcile().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async reconcile(): Promise<Map<string, ConnectedMcpServer>> {
    const wanted = this.source();
    const closing: Promise<void>[] = [];
    for (const [name, entry] of this.entries) {
      const config = wanted[name];
      if (config && JSON.stringify(config) === entry.digest) continue;
      this.entries.delete(name);
      closing.push(entry.server.close().catch(() => {}));
    }
    await Promise.all([
      ...closing,
      ...Object.entries(wanted).map(async ([name, config]) => {
        if (this.entries.has(name)) return;
        try {
          const server = await connectMcpServer(
            config,
            this.onElicit ? { onElicit: this.onElicit } : undefined,
          );
          this.entries.set(name, { digest: JSON.stringify(config), server });
        } catch (cause) {
          console.warn(
            `[ai-sdk] MCP server "${name}" failed to connect:`,
            cause,
          );
        }
      }),
    ]);
    return new Map(
      [...this.entries].map(([name, entry]) => [name, entry.server]),
    );
  }

  async close(): Promise<void> {
    const servers = [...this.entries.values()].map((entry) => entry.server);
    this.entries.clear();
    await Promise.all(servers.map((server) => server.close().catch(() => {})));
  }
}

/**
 * MCP server tools → ai-sdk dynamic tools named `mcp__<server>__<tool>`
 * (the same namespacing Claude Code uses, so events read alike across
 * harnesses). Results are flattened text; errors surface as tool errors.
 */
/** Resolves (tool may run) or throws (refused/declined) before a call. */
type McpToolGate = (
  server: string,
  tool: McpToolInfo,
  input: Record<string, unknown>,
  sessionId?: string,
  abortSignal?: AbortSignal,
) => Promise<void>;

function buildMcpTools(
  /** The roster to declare tools from. */
  connections: Map<string, ConnectedMcpServer>,
  /** Where a call finds its server — live, so a reconnected server (rotated
   * credential) is what runs, under the tool names declared at start. */
  live: { get(name: string): ConnectedMcpServer | undefined },
  gate?: McpToolGate,
  sessionId?: string,
): Record<string, Tool> {
  const tools: Record<string, Tool> = {};
  for (const [serverName, roster] of connections) {
    const safeServer = serverName.replace(/[^A-Za-z0-9-]+/g, "_");
    for (const info of roster.tools) {
      tools[`mcp__${safeServer}__${info.name}`] = dynamicTool({
        description: info.description,
        inputSchema: jsonSchema<Record<string, unknown>>(
          info.inputSchema as Parameters<typeof jsonSchema>[0],
        ),
        execute: async (input, options) => {
          const args = pruneEmptyOptionalArgs(
            input as Record<string, unknown>,
            info.inputSchema,
          );
          // Permission first: deny/ask throw with a message the model
          // reads as the tool result — the turn goes on. An interrupted
          // turn abandons a parked ask instead of running the tool later.
          await gate?.(serverName, info, args, sessionId, options?.abortSignal);
          options?.abortSignal?.throwIfAborted();
          const server = live.get(serverName);
          if (!server) {
            throw new Error(
              `The MCP server "${serverName}" is not connected right now — its connection failed; try again in a moment.`,
            );
          }
          // Prefer structured content: MCP Apps views render it, and the
          // model reads JSON fine. Text-only results stay text;
          // flattenToolResult throws on isError results.
          const raw = await server.callToolRaw(info.name, args);
          if (raw.structuredContent !== undefined && !raw.isError) {
            return raw.structuredContent;
          }
          return truncateToolOutput(
            flattenToolResult(raw as Parameters<typeof flattenToolResult>[0]),
          );
        },
      });
    }
  }
  return tools;
}

/**
 * Some models (OpenAI-family especially) fill every declared property and
 * send `""`/`null` for the ones they have no value for; servers that
 * validate optional fields then reject the call ("value is not a channel
 * ID" for `context_channel_id: ""`, from Slack's search tool). Drop such
 * values for optional properties — but ONLY when the property's own schema
 * could not have meant them: a `null` a schema admits (`type: [...,
 * "null"]`, `nullable`, an `anyOf` null branch, an `enum` with null) is a
 * value ("clear this field"), and so is `""` on a plain string with no
 * `format`/`pattern`/`minLength`/`enum` ruling it out. Unknown properties
 * (no schema) keep the old blanket rule.
 */
export function pruneEmptyOptionalArgs(
  input: Record<string, unknown>,
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const required = new Set(
    Array.isArray(schema.required) ? (schema.required as string[]) : [],
  );
  const properties =
    typeof schema.properties === "object" && schema.properties !== null
      ? (schema.properties as Record<string, unknown>)
      : {};
  const pruned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (required.has(key) || (value !== "" && value !== null)) {
      pruned[key] = value;
      continue;
    }
    const property =
      typeof properties[key] === "object" && properties[key] !== null
        ? (properties[key] as Record<string, unknown>)
        : undefined;
    const meaningful =
      value === null
        ? schemaAdmitsNull(property)
        : schemaAdmitsEmptyString(property);
    if (meaningful) pruned[key] = value;
  }
  return pruned;
}

function schemaAdmitsNull(
  property: Record<string, unknown> | undefined,
): boolean {
  if (!property) return false;
  if (property.nullable === true) return true;
  const type = property.type;
  if (type === "null" || (Array.isArray(type) && type.includes("null"))) {
    return true;
  }
  if (Array.isArray(property.enum) && property.enum.includes(null)) return true;
  for (const branchKey of ["anyOf", "oneOf"] as const) {
    const branches = property[branchKey];
    if (
      Array.isArray(branches) &&
      branches.some((branch) =>
        schemaAdmitsNull(
          typeof branch === "object" && branch !== null
            ? (branch as Record<string, unknown>)
            : undefined,
        ),
      )
    ) {
      return true;
    }
  }
  return false;
}

function schemaAdmitsEmptyString(
  property: Record<string, unknown> | undefined,
): boolean {
  if (!property) return false;
  const type = property.type;
  const isString =
    type === "string" || (Array.isArray(type) && type.includes("string"));
  if (!isString) return false;
  if (Array.isArray(property.enum)) return property.enum.includes("");
  if (typeof property.minLength === "number" && property.minLength > 0) {
    return false;
  }
  if (property.format !== undefined || property.pattern !== undefined) {
    return false;
  }
  return true;
}

function createTools(
  context: ToolContext,
  extraTools: ExtraTool[] = [],
  extraContext: ExtraToolContext = { projectId: "" },
  mcpTools: Record<string, Tool> = {},
) {
  let mutationQueue = Promise.resolve();
  const serializeMutation = async <T>(operation: () => Promise<T>) => {
    const result = mutationQueue.then(operation, operation);
    mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const resolvePath = (filePath: string): string => {
    const workingDirectory = path.posix.resolve(context.workingDirectory);
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
    // Spread first: a host or MCP tool never shadows a built-in of the
    // same name.
    ...mcpTools,
    ...Object.fromEntries(
      extraTools.map((extra) => [
        extra.name,
        tool({
          description: extra.description,
          inputSchema: z.object(extra.parameters as z.ZodRawShape),
          execute: async (input: Record<string, unknown>) => {
            const result = await extra.execute(input, extraContext);
            return typeof result === "string"
              ? truncateToolOutput(result)
              : result;
          },
        }),
      ]),
    ),
    read: tool({
      description: "Read a UTF-8 text file from the project.",
      inputSchema: z.object({
        path: z.string().describe("Project-relative or absolute file path"),
      }),
      execute: async ({ path: filePath }) =>
        truncateToolOutput(
          await context.provider.downloadFile(
            context.sandboxId,
            resolvePath(filePath),
          ),
        ),
    }),
    write: tool({
      description: "Create or replace a UTF-8 text file in the project.",
      inputSchema: z.object({
        path: z.string().describe("Project-relative or absolute file path"),
        content: z.string(),
      }),
      execute: async ({ path: filePath, content }) =>
        serializeMutation(async () => {
          const absolutePath = resolvePath(filePath);
          const relativePath = path.posix.relative(
            context.workingDirectory,
            absolutePath,
          );
          await context.provider.uploadFiles(
            context.sandboxId,
            { [relativePath]: content },
            context.workingDirectory,
          );
          return `Wrote ${relativePath}`;
        }),
    }),
    edit: tool({
      description: "Replace one exact string occurrence in a project file.",
      inputSchema: z.object({
        path: z.string().describe("Project-relative or absolute file path"),
        oldText: z.string().describe("Exact text to replace"),
        newText: z.string().describe("Replacement text"),
      }),
      execute: async ({ path: filePath, oldText, newText }) =>
        serializeMutation(async () => {
          const absolutePath = resolvePath(filePath);
          const content = await context.provider.downloadFile(
            context.sandboxId,
            absolutePath,
          );
          const first = content.indexOf(oldText);
          if (first === -1) {
            throw new Error(`Text not found in ${filePath}`);
          }
          if (content.indexOf(oldText, first + oldText.length) !== -1) {
            throw new Error(`Text occurs more than once in ${filePath}`);
          }
          const updated = `${content.slice(0, first)}${newText}${content.slice(first + oldText.length)}`;
          const relativePath = path.posix.relative(
            context.workingDirectory,
            absolutePath,
          );
          await context.provider.uploadFiles(
            context.sandboxId,
            { [relativePath]: updated },
            context.workingDirectory,
          );
          return `Edited ${relativePath}`;
        }),
    }),
    websearch: tool({
      description:
        "Search the web and return results with content excerpts optimized for reading. Use it for up-to-date information, documentation, or anything outside the project.",
      inputSchema: z.object({
        query: z.string().describe("Web search query"),
        numResults: z
          .number()
          .int()
          .positive()
          .max(20)
          .optional()
          .describe("Number of results to return (default 8)"),
      }),
      execute: async ({ query, numResults }) =>
        truncateToolOutput(await exaWebSearch(query, numResults ?? 8)),
    }),
    webfetch: tool({
      description:
        "Fetch a URL and return its content as text. Use it to read pages found via websearch or URLs provided by the user.",
      inputSchema: z.object({
        url: z.string().describe("The http(s) URL to fetch"),
      }),
      execute: async ({ url }) => truncateToolOutput(await webFetch(url)),
    }),
    set_title: tool({
      description:
        "Set the title of this conversation as shown in the user's chat list and tabs. Call it once near the start of a new conversation with a concise, specific title (2-5 words, sentence case, no trailing punctuation) describing what the conversation is about. Call it again whenever the current title no longer describes the conversation — the topic moved on, the scope changed, or the original title turned out to be wrong. Don't re-title for minor detours. Examples: 'Daily sales report workflow', 'Drafting onboarding doc', 'Fixing checkout bug', 'Getting to know you'.",
      inputSchema: z.object({
        title: z
          .string()
          .min(1)
          .max(80)
          .describe("The new conversation title (2-5 words)"),
      }),
      execute: async ({ title }) => `Conversation titled: ${title}`,
    }),
    // No execute: calling it ends the tool loop; the user's answer comes
    // back as the tool result on the next sendMessage.
    ask_user: tool({
      description: `Ask the user one or more multiple-choice questions and wait for their answers. ALWAYS use this tool instead of writing questions as plain text whenever you are asking the user something and their answer shapes what you do next. Use it when (1) you are blocked on a decision that is genuinely the user's to make — one you cannot resolve from the request, the project, or sensible defaults, e.g. choosing between data sources, schedules, external services, or destructive vs. safe variants of an operation; or (2) the user asks you to interview them, gather their preferences, or otherwise requests that you ask them questions — a request like "ask me some questions" should go through this tool, batching up to 4 questions per call and calling it again for follow-ups. For routine implementation choices, pick a sensible default and state it instead of asking. Each option needs a concise label and a description explaining its effects, implications, or trade-offs; for open-ended questions offer plausible example answers as options — the user can always answer with free text instead of picking one. If you recommend an option, make it the first one and append " (Recommended)" to its label. Do not use it to ask "should I proceed?" or to confirm work you already described.`,
      inputSchema: z.object({
        questions: z
          .array(
            z.object({
              question: z
                .string()
                .describe(
                  "The complete question to ask, ending with a question mark",
                ),
              header: z
                .string()
                .describe(
                  "Very short label shown as the question's tab (max 12 chars), e.g. 'Data source'",
                ),
              multiSelect: z
                .boolean()
                .describe(
                  "Whether the user may select multiple options instead of one",
                ),
              options: z
                .array(
                  z.object({
                    label: z
                      .string()
                      .describe("Concise display text (1-5 words)"),
                    description: z
                      .string()
                      .describe(
                        "What this option means or what happens if chosen — effects, implications, trade-offs",
                      ),
                  }),
                )
                .min(2)
                .max(4)
                .describe("2-4 distinct, mutually exclusive choices"),
            }),
          )
          .min(1)
          .max(4)
          .describe("Questions to ask the user (1-4)"),
      }),
    }),
    bash: tool({
      description:
        "Run a shell command in the project sandbox. Use it for listing, searching, tests, builds, and other project operations.",
      inputSchema: z.object({
        command: z.string(),
        timeoutMs: z.number().int().positive().max(3_600_000).optional(),
      }),
      execute: async ({ command, timeoutMs }) => {
        const result = await context.provider.executeCommand(
          context.sandboxId,
          command,
          {
            cwd: context.workingDirectory,
            timeout:
              timeoutMs === undefined ? undefined : Math.ceil(timeoutMs / 1000),
          },
        );
        return {
          exitCode: result.exitCode,
          output: truncateToolOutput(result.result),
        };
      },
    }),
  };
}

function parseAskUserInput(input: unknown): AgentQuestion[] {
  const record = asRecord(input);
  const rawQuestions = Array.isArray(record?.questions) ? record.questions : [];
  return rawQuestions.flatMap((raw): AgentQuestion[] => {
    const question = asRecord(raw);
    if (typeof question?.question !== "string") return [];
    const options = Array.isArray(question.options)
      ? question.options.flatMap((option): AgentQuestion["options"] => {
          const entry = asRecord(option);
          return typeof entry?.label === "string"
            ? [
                {
                  label: entry.label,
                  description:
                    typeof entry.description === "string"
                      ? entry.description
                      : "",
                },
              ]
            : [];
        })
      : [];
    return [
      {
        question: question.question,
        header:
          typeof question.header === "string" && question.header.length > 0
            ? question.header
            : "Question",
        multiSelect: question.multiSelect === true,
        options,
      },
    ];
  });
}

function mapToolCall(toolName: string, input: unknown): AgentEvent {
  const values = asRecord(input);
  // MCP tools surface as "server/tool" — the transport prefix is plumbing.
  const mcpName = toolName.match(/^mcp__([^_]+(?:_[^_]+)*)__(.+)$/);
  if (mcpName) {
    return {
      type: "tool_call",
      toolName: `${mcpName[1]}/${mcpName[2]}`,
      toolInput: input,
    };
  }
  if (toolName === "set_title") {
    return {
      type: "title",
      content: typeof values?.title === "string" ? values.title : "",
    };
  }
  if (toolName === "bash") {
    return {
      type: "command",
      content: typeof values?.command === "string" ? values.command : "",
    };
  }
  if (toolName === "write" || toolName === "edit") {
    return {
      type: "file_edit",
      content: toolName,
      filePath: typeof values?.path === "string" ? values.path : undefined,
    };
  }
  return { type: "tool_call", toolName, toolInput: input };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * One AgentTurnUsage from the AI SDK's LanguageModelUsage (ADR 0057).
 * `inputTokens` here is the provider's total prompt count; the cached and
 * uncached splits live in inputTokenDetails when the provider reports them.
 */
function turnUsageFromAiSdk(
  usage: {
    inputTokens: number | undefined;
    inputTokenDetails: {
      noCacheTokens: number | undefined;
      cacheReadTokens: number | undefined;
      cacheWriteTokens: number | undefined;
    };
    outputTokens: number | undefined;
    outputTokenDetails: { reasoningTokens: number | undefined };
  },
  model: string | undefined,
): AgentTurnUsage | undefined {
  const input = positiveTokenCount(usage.inputTokens);
  const cached = positiveTokenCount(usage.inputTokenDetails?.cacheReadTokens);
  const cacheCreation = positiveTokenCount(
    usage.inputTokenDetails?.cacheWriteTokens,
  );
  const output = positiveTokenCount(usage.outputTokens);
  if (input + output === 0) return undefined;
  return {
    ...(model ? { model } : {}),
    // Total prompt tokens include the cached portion; report the uncached
    // remainder so the counters never double count.
    inputTokens: Math.max(0, input - cached - cacheCreation),
    cachedInputTokens: cached,
    cacheCreationTokens: cacheCreation,
    outputTokens: output,
    reasoningTokens: Math.min(
      output,
      positiveTokenCount(usage.outputTokenDetails?.reasoningTokens),
    ),
  };
}

function truncateToolOutput(output: string): string {
  if (output.length <= MAX_TOOL_OUTPUT_LENGTH) return output;
  return `${output.slice(0, MAX_TOOL_OUTPUT_LENGTH)}\n...[output truncated]`;
}

/** Free keyless web search via Exa's public MCP endpoint (same approach as opencode). */
async function exaWebSearch(
  query: string,
  numResults: number,
): Promise<string> {
  const response = await fetch(EXA_MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "web_search_exa",
        arguments: { query, numResults, type: "auto", livecrawl: "fallback" },
      },
    }),
    signal: AbortSignal.timeout(WEBFETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Web search failed with status ${response.status}`);
  }
  const body = await response.text();
  const result = parseMcpToolResult(body);
  return result ?? "No search results found. Try a different query.";
}

function parseMcpToolResult(body: string): string | undefined {
  const payloads = body.trim().startsWith("{")
    ? [body.trim()]
    : body
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice(6));
  for (const payload of payloads) {
    try {
      const data = JSON.parse(payload) as {
        result?: { content?: Array<{ text?: string }> };
      };
      const text = data.result?.content?.find((item) => item.text)?.text;
      if (text) return text;
    } catch {
      // skip malformed SSE payloads
    }
  }
  return undefined;
}

async function webFetch(url: string): Promise<string> {
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    throw new Error("URL must start with http:// or https://");
  }
  const response = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
      Accept:
        "text/markdown;q=1.0, text/plain;q=0.9, text/html;q=0.8, */*;q=0.1",
      "Accept-Language": "en-US,en;q=0.9",
    },
    signal: AbortSignal.timeout(WEBFETCH_TIMEOUT_MS),
    redirect: "follow",
  });
  if (!response.ok) {
    throw new Error(`Fetch failed with status ${response.status}`);
  }
  const contentLength = response.headers.get("content-length");
  if (
    contentLength &&
    Number.parseInt(contentLength, 10) > WEBFETCH_MAX_BYTES
  ) {
    throw new Error("Response too large (exceeds 5MB limit)");
  }
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > WEBFETCH_MAX_BYTES) {
    throw new Error("Response too large (exceeds 5MB limit)");
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (
    contentType &&
    !/text|json|xml|javascript|markdown|html/i.test(contentType)
  ) {
    throw new Error(`Unsupported content type: ${contentType}`);
  }
  const text = new TextDecoder().decode(buffer);
  return contentType.includes("html") ? htmlToText(text) : text;
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article|blockquote|pre)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
