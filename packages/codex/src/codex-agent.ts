import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentAttachment,
  AgentCapabilityGateway,
  AgentEffort,
  AgentEvent,
  AgentMcpServerConfig,
  AgentTurnUsage,
  CodingAgentProvider,
  ExtraToolContext,
  McpServersSource,
  McpToolPolicyLayers,
  ProviderSession,
  StartSessionOpts,
  ToolPermissionHandler,
  ToolPolicyAnnotations,
  TurnOptions,
} from "@catamorphic/sandbox";
import {
  buildPluginsPreamble,
  listenAgentCapabilityGateway,
  mergePolicyLayers,
  positiveTokenCount,
  renderUserMessage,
  resolveMcpServers,
  resolveToolPermissionAcross,
  stagePluginDocs,
} from "@catamorphic/sandbox";
import type {
  CodexOptions,
  ThreadEvent,
  ThreadItem,
  ThreadOptions,
  UserInput,
} from "@openai/codex-sdk";

import {
  CodexAppServer,
  type CodexElicitation,
  type CodexElicitationResult,
} from "./app-server.js";

type CodexConfigObject = NonNullable<CodexOptions["config"]>;

export interface CodexAgentOpts {
  onToolPermission?: ToolPermissionHandler;
  /** A handler per native session lifetime; discarded on restart or disposal. */
  mcpElicitationForSession?: (context: {
    sessionId: string;
  }) => (
    request: CodexElicitation,
    signal?: AbortSignal,
  ) => Promise<CodexElicitationResult>;
  /** API-key auth; omit to use the CODEX_HOME account login (`codex login`). */
  apiKey?: string;
  baseUrl?: string;
  /** Path to a specific `codex` binary (Electron hosts ship their own). */
  codexPathOverride?: string;
  /**
   * Extra environment for the spawned CLI, merged over `process.env`. Set
   * `CODEX_HOME` to isolate credentials/sessions per account — each
   * configured Codex agent can point at its own home directory.
   */
  env?: Record<string, string>;
  /** Default model for sessions (e.g. "gpt-5.3-codex"). */
  model?: string;
  /** Default reasoning effort; maps to the CLI's model_reasoning_effort. */
  effort?: AgentEffort;
  /**
   * Codex's own OS-level sandbox policy. Defaults to "workspace-write" with
   * approvals off — the CLI's designed unattended mode: free rein inside the
   * working directory, everything else read-only.
   */
  sandboxMode?: "read-only" | "workspace-write" | "danger-full-access";
  /** Allow network access inside the workspace-write sandbox (default true). */
  networkAccessEnabled?: boolean;
  /** Use the host's first-class subsessions instead of Codex's private agents. */
  disableNativeSubagents?: boolean;
  /** Use the host's session todo list instead of Codex's private goals. */
  disableNativeGoals?: boolean;
  /**
   * Native MCP configuration, resolved each turn. Changed credentials or policies
   * restart the session's app-server; unchanged configuration retains MCP state.
   */
  mcpServers?: McpServersSource;
  /** Host-owned MCP servers resolved for the current project/session. */
  mcpServersForSession?: (
    context: ExtraToolContext,
  ) => Record<string, AgentMcpServerConfig>;
  /**
   * Per-server tool policies intersect before native tool discovery. `ask` still
   * fails closed here; the service's own elicitation is handled separately through
   * mcpElicitationForSession. Known annotations resolve `auto`; unknown tools need an
   * explicit allow default.
   */
  mcpPolicies?:
    | Record<string, McpToolPolicyLayers>
    | (() => Record<string, McpToolPolicyLayers> | undefined);
  /** Tool annotations per server, so `auto` can be resolved at spawn. */
  mcpToolAnnotations?:
    | Record<string, Record<string, ToolPolicyAnnotations>>
    | (() => Record<string, Record<string, ToolPolicyAnnotations>> | undefined);
}

/**
 * Coding agent backed by the native OpenAI Codex app-server. The Codex CLI runs on the
 * **host machine** and operates on a local working directory — use it when
 * the project checkout the agent should edit lives on the same filesystem
 * as the server (or when the host itself is the isolation boundary, e.g. a
 * CI runner). For agents that drive a remote dev sandbox, see
 * `@catamorphic/ai-sdk`.
 *
 * Sessions survive host restarts: the CLI persists threads under
 * `$CODEX_HOME/sessions`, and every turn resumes by thread id. Native
 * turn options refresh model/effort without discarding MCP state.
 */
export class CodexAgent implements CodingAgentProvider {
  readonly name = "codex";
  private readonly opts: CodexAgentOpts;
  /** Standing developer instructions, refreshed at start and retained through resume. */
  private readonly sessionInstructions = new Map<string, string>();
  /**
   * The caller's tool-policy layers per host session id (ADR 0055). Codex
   * reads policy at spawn, so a session serving a scoped caller spawns
   * through a client built with the merged (provider ∩ caller) filter —
   * memoized by digest in {@link clientFor}, refreshed each turn.
   */
  private readonly callerPolicies = new Map<
    string,
    Record<string, McpToolPolicyLayers>
  >();
  private readonly sessionMcpServers = new Map<
    string,
    Record<string, AgentMcpServerConfig>
  >();
  private readonly sessionContexts = new Map<string, ExtraToolContext>();
  private readonly turnAbortControllers = new Map<string, AbortController>();
  constructor(opts: CodexAgentOpts = {}) {
    this.opts = opts;
  }

  private buildClient(
    config: CodexOptions["config"] | undefined,
    sessionId: string,
  ): CodexAppServer {
    return new CodexAppServer(
      {
        apiKey: this.opts.apiKey,
        baseUrl: this.opts.baseUrl,
        codexPathOverride: this.opts.codexPathOverride,
        ...(config ? { config } : {}),
        // Preserve the host environment alongside explicit account overrides.
        ...(this.opts.env ? { env: mergedEnv(this.opts.env) } : {}),
      },
      this.opts.mcpElicitationForSession?.({ sessionId }),
      this.opts.onToolPermission,
      sessionId,
    );
  }

  /** Reuse native MCP state until connection credentials or policy change. */
  private clients = new Map<
    string,
    { signature: string; client: CodexAppServer }
  >();

  private clientFor(
    session: ProviderSession,
    capabilityServer?: AgentMcpServerConfig,
    contextPrompt?: string,
  ): CodexAppServer {
    const own =
      typeof this.opts.mcpPolicies === "function"
        ? this.opts.mcpPolicies()
        : this.opts.mcpPolicies;
    const annotations =
      typeof this.opts.mcpToolAnnotations === "function"
        ? this.opts.mcpToolAnnotations()
        : this.opts.mcpToolAnnotations;
    const context = {
      ...this.sessionContexts.get(session.sessionId),
      projectId: session.projectId,
      sessionId: session.sessionId,
      workingDirectory: session.workingDirectory,
    };
    // Host checkout assignments can change between turns. Preserve the
    // caller captured at start while refreshing the live session fields.
    this.sessionContexts.set(session.sessionId, context);
    const mcpConfig = mcpServersConfig(
      {
        ...resolveMcpServers(this.opts.mcpServers),
        ...this.opts.mcpServersForSession?.(context),
        ...this.sessionMcpServers.get(session.sessionId),
        ...(capabilityServer
          ? {
              catamorphic_capabilities: {
                ...capabilityServer,
                defaultToolsApprovalMode: "approve",
              },
            }
          : {}),
      },
      mergePolicyLayers(own, this.callerPolicies.get(session.sessionId)),
      annotations,
    );
    const features = {
      ...(this.opts.disableNativeSubagents ? { multi_agent: false } : {}),
      ...(this.opts.disableNativeGoals ? { goals: false } : {}),
    };
    const config =
      Object.keys(features).length > 0 ? { ...mcpConfig, features } : mcpConfig;
    const signature = JSON.stringify(config);
    const existing = this.clients.get(session.sessionId);
    if (existing?.client.available && existing.signature === signature) {
      existing.client.setContext(contextPrompt);
      return existing.client;
    }
    existing?.client.close();
    const client = this.buildClient(config, session.sessionId);
    client.setContext(contextPrompt);
    this.clients.set(session.sessionId, { signature, client });
    return client;
  }

  async startSession(opts: StartSessionOpts): Promise<ProviderSession> {
    await stagePluginDocs(opts.workingDirectory, opts.attachedPlugins);
    const preamble = buildPluginsPreamble(opts.attachedPlugins);
    const instructions = [preamble, opts.systemPrompt ?? ""]
      .filter(Boolean)
      .join("\n\n");
    if (instructions) {
      this.sessionInstructions.set(opts.sessionId, instructions);
    }
    if (opts.toolPolicies) {
      this.callerPolicies.set(opts.sessionId, opts.toolPolicies);
    }
    if (opts.mcpServers) {
      this.sessionMcpServers.set(opts.sessionId, opts.mcpServers);
    }
    this.sessionContexts.set(opts.sessionId, {
      projectId: opts.projectId,
      sessionId: opts.sessionId,
      workingDirectory: opts.workingDirectory,
      ...(opts.caller ? { caller: opts.caller } : {}),
    });

    // The CLI only reveals its thread id once a turn starts, so the id stays
    // null here and the first real turn reports it via a "session" event —
    // the transcript begins with the user's own message, nothing synthetic.
    return {
      providerSessionId: null,
      sessionId: opts.sessionId,
      projectId: opts.projectId,
      sandboxId: opts.sandboxId,
      workingDirectory: opts.workingDirectory,
    };
  }

  async *sendMessage(
    session: ProviderSession,
    message: string,
    opts?: TurnOptions,
  ): AsyncIterable<AgentEvent> {
    if (this.runningSessions.has(session.sessionId))
      throw new Error("A turn is already running in this session.");
    this.runningSessions.add(session.sessionId);
    let entry = this.gateways.get(session.sessionId);
    try {
      if (opts?.capabilities && !entry) {
        const state: { current?: AgentCapabilityGateway } = {
          current: opts.capabilities,
        };
        const listener = await listenAgentCapabilityGateway({
          discover: (args) => {
            if (!state.current) throw new Error("No active turn");
            return state.current.discover(args);
          },
          invoke: (args) => {
            if (!state.current) throw new Error("No active turn");
            return state.current.invoke(args);
          },
        });
        entry = { state, listener };
        this.gateways.set(session.sessionId, entry);
      }
      if (entry) entry.state.current = opts?.capabilities;
      yield* this.sendMessageOnHost(
        session,
        message,
        opts,
        entry?.listener.config,
      );
    } finally {
      if (entry) entry.state.current = undefined;
      this.runningSessions.delete(session.sessionId);
    }
  }

  private runningSessions = new Set<string>();

  private gateways = new Map<
    string,
    {
      state: { current?: AgentCapabilityGateway };
      listener: Awaited<ReturnType<typeof listenAgentCapabilityGateway>>;
    }
  >();

  private async *sendMessageOnHost(
    session: ProviderSession,
    message: string,
    opts?: TurnOptions,
    capabilityServer?: AgentMcpServerConfig,
  ): AsyncIterable<AgentEvent> {
    // Native turn options refresh while MCP processes survive between turns.
    if (opts?.toolPolicies) {
      this.callerPolicies.set(session.sessionId, opts.toolPolicies);
    }
    const context =
      [this.sessionInstructions.get(session.sessionId), opts?.context]
        .filter(Boolean)
        .join("\n\n") || undefined;
    const client = this.clientFor(session, capabilityServer, context);
    const threadOptions = this.threadOptions(session.workingDirectory, opts);
    const thread = session.providerSessionId
      ? client.resumeThread(session.providerSessionId, threadOptions)
      : client.startThread(threadOptions);
    const prose = renderUserMessage(message, opts?.attachments);
    const text = prose;
    const abortController = new AbortController();
    this.turnAbortControllers.set(session.sessionId, abortController);
    if (session.providerSessionId) {
      this.turnAbortControllers.set(session.providerSessionId, abortController);
    }

    let stream: AsyncIterable<ThreadEvent>;
    let staged: Awaited<ReturnType<typeof stageTurnInput>> | undefined;
    try {
      staged = await stageTurnInput(text, opts?.attachments);
      stream = (
        await thread.runStreamed(staged.input, {
          signal: abortController.signal,
          turnOptions: opts,
        })
      ).events;
    } catch (error) {
      this.clearAbortController(abortController);
      await staged?.cleanup();
      yield { type: "error", content: describeError(error) };
      yield { type: "done" };
      return;
    }

    // Codex gives the model no background-process tools, so watchers are
    // detected instead of intercepted: commands that daemonize something
    // (trailing "&", nohup, docker -d, …) and commands still running when
    // the turn ends both surface as "background" events.
    const runningCommands = new Map<string, string>();
    let terminal = false;
    let streamError: string | undefined;
    try {
      for await (const event of stream) {
        // The pinned CLI also uses top-level errors for retries. Report the
        // progress now, but fail only if the turn actually fails or ends
        // without a terminal event. A recovered connection must not poison
        // the host's durable turn status.
        if (event.type === "error") {
          streamError = event.message;
          yield { type: "diagnostic", content: event.message };
          continue;
        }
        if (event.type === "turn.completed" || event.type === "turn.failed") {
          terminal = true;
        }
        if (event.type === "thread.started" && !session.providerSessionId) {
          this.turnAbortControllers.set(event.thread_id, abortController);
          yield { type: "session", providerSessionId: event.thread_id };
        }
        if (event.type === "item.started" || event.type === "item.updated") {
          const item = event.item;
          if (
            item.type === "command_execution" &&
            item.status === "in_progress"
          ) {
            runningCommands.set(item.id, item.command);
          }
        }
        if (event.type === "item.completed") {
          runningCommands.delete(event.item.id);
        }
        if (event.type === "turn.completed" || event.type === "turn.failed") {
          for (const [id, command] of runningCommands) {
            yield {
              type: "background",
              status: "detected",
              backgroundId: `codex-exec-${id}`,
              content: command,
            };
          }
          runningCommands.clear();
        }
        yield* mapEvent(event, opts?.model ?? this.opts.model);
      }
      if (!terminal) {
        yield {
          type: "error",
          content: streamError ?? "Codex ended before completing the turn.",
        };
        yield { type: "done" };
      }
    } catch (error) {
      yield { type: "error", content: describeError(error) };
      yield { type: "done" };
    } finally {
      this.clearAbortController(abortController);
      await staged.cleanup();
    }
  }

  interrupt(providerSessionId: string): void {
    this.turnAbortControllers.get(providerSessionId)?.abort();
  }

  async dispose(session: ProviderSession): Promise<void> {
    // Preserve durable transcripts while releasing all live process resources.
    this.interrupt(session.providerSessionId ?? session.sessionId);
    this.clients.get(session.sessionId)?.client.close();
    this.clients.delete(session.sessionId);
    await this.gateways.get(session.sessionId)?.listener.close();
    this.gateways.delete(session.sessionId);
    this.sessionInstructions.delete(session.sessionId);
    this.callerPolicies.delete(session.sessionId);
    this.sessionContexts.delete(session.sessionId);
    this.sessionMcpServers.delete(session.sessionId);
  }

  private clearAbortController(controller: AbortController): void {
    for (const [key, current] of this.turnAbortControllers) {
      if (current === controller) this.turnAbortControllers.delete(key);
    }
  }

  private threadOptions(
    workingDirectory: string,
    turn?: TurnOptions,
  ): ThreadOptions {
    const model = turn?.model ?? this.opts.model;
    const effort = turn?.effort ?? this.opts.effort;
    return {
      ...(workingDirectory ? { workingDirectory } : {}),
      skipGitRepoCheck: true,
      sandboxMode: this.opts.sandboxMode ?? "workspace-write",
      approvalPolicy:
        this.opts.mcpElicitationForSession || this.opts.onToolPermission
          ? "on-request"
          : "never",
      networkAccessEnabled: this.opts.networkAccessEnabled ?? true,
      ...(model ? { model } : {}),
      ...(effort ? { modelReasoningEffort: effort } : {}),
    };
  }
}

/**
 * Host-neutral MCP configs → Codex `--config mcp_servers.*` overrides.
 * Remote servers use the CLI's `url` (+ `http_headers`) form; local ones
 * its `command`/`args`/`env` form.
 */
function mcpServersConfig(
  servers: Record<string, AgentMcpServerConfig>,
  policies?: Record<string, McpToolPolicyLayers>,
  annotations?: Record<string, Record<string, ToolPolicyAnnotations>>,
): CodexOptions["config"] | undefined {
  const names = Object.keys(servers);
  if (names.length === 0) return undefined;
  const mcpServers: Record<string, CodexConfigObject> = {};
  for (const [name, config] of Object.entries(servers)) {
    // Codex config keys are TOML bare keys; anything else must be quoted
    // upstream, so normalize here instead of failing at spawn time.
    const key = name.replace(/[^A-Za-z0-9_-]/g, "_");
    const filter = codexToolFilter(policies?.[name], annotations?.[name]);
    mcpServers[key] = {
      ...(config.transport === "stdio"
        ? {
            command: config.command,
            ...(config.cwd ? { cwd: config.cwd } : {}),
            ...(config.envVars ? { env_vars: config.envVars } : {}),
            ...(config.args ? { args: config.args } : {}),
            ...(config.env ? { env: config.env } : {}),
          }
        : {
            url: config.url,
            ...(config.headers ? { http_headers: config.headers } : {}),
          }),
      ...(filter.enabled_tools ? { enabled_tools: filter.enabled_tools } : {}),
      ...(filter.disabled_tools
        ? { disabled_tools: filter.disabled_tools }
        : {}),
      ...(config.defaultToolsApprovalMode
        ? {
            default_tools_approval_mode: config.defaultToolsApprovalMode,
          }
        : {}),
    };
  }
  return { mcp_servers: mcpServers };
}

/**
 * The Codex-side rendering of a policy: the same per-tool resolution the
 * shared `ToolGate` runs live in the other harnesses, applied once at
 * native discovery; tool-level ask fails closed.
 * Two shapes:
 * - When tools the host has NOT listed would still be allowed (every
 *   layer's default is `allow`), an unknown tool may run: emit
 *   `disabled_tools` for the known ones that resolve to anything else.
 * - Otherwise an unknown tool must not run (it would resolve to ask/deny,
 *   or to `auto` without annotations = ask): emit `enabled_tools`, the
 *   allowlist of known tools that resolve to `allow`.
 */
export function codexToolFilter(
  layers: McpToolPolicyLayers | undefined,
  annotations: Record<string, ToolPolicyAnnotations> | undefined,
): { enabled_tools?: string[]; disabled_tools?: string[] } {
  if (!layers || layers.length === 0) return {};
  const known = new Set<string>([
    ...layers.flatMap((layer) => Object.keys(layer.tools ?? {})),
    ...Object.keys(annotations ?? {}),
  ]);
  const resolve = (tool: string) =>
    resolveToolPermissionAcross(layers, tool, annotations?.[tool]);
  // A tool nobody named and nobody annotated: does it run?
  const unknownRuns = resolve("\u0000unknown-tool\u0000") === "allow";
  const sorted = [...known].sort();
  if (unknownRuns) {
    const disabled = sorted.filter((tool) => resolve(tool) !== "allow");
    return disabled.length > 0 ? { disabled_tools: disabled } : {};
  }
  return { enabled_tools: sorted.filter((tool) => resolve(tool) === "allow") };
}

/**
 * Commands that hand a process off to the background: shell job control
 * (trailing "&"), the classic detachers, and the daemon flags of the
 * common dev servers. Conservative on purpose — a false "watcher" chip is
 * noise the user has to dismiss.
 */
const DAEMONIZING_COMMAND = new RegExp(
  [
    String.raw`(?:^|[;&|]\s*)nohup\s`,
    String.raw`(?:^|[;&|]\s*)setsid\s`,
    String.raw`&\s*$`,
    String.raw`\bdocker\s+(?:container\s+)?run\b[^;|&]*\s(?:-d|--detach)\b`,
    String.raw`\bdocker\s+compose\b[^;|&]*\bup\b[^;|&]*\s(?:-d|--detach)\b`,
    String.raw`\bdocker-compose\b[^;|&]*\bup\b[^;|&]*\s(?:-d|--detach)\b`,
    String.raw`\bpm2\s+start\b`,
    String.raw`\btmux\s+new(?:-session)?\s[^;|&]*-d\b`,
    String.raw`\bscreen\s+-dm\b`,
  ].join("|"),
);

/** Whether a completed command likely left a process running behind it. */
export function isDaemonizingCommand(command: string): boolean {
  return DAEMONIZING_COMMAND.test(command.trim());
}

function mergedEnv(overrides: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  return { ...env, ...overrides };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * One AgentTurnUsage from a turn.completed event (ADR 0057). Codex reports
 * `input_tokens` inclusive of the cached portion, so the uncached figure is
 * the difference; `reasoning_output_tokens` is a subset of output. The SDK
 * stream reports no context window, so occupancy fields stay unset.
 */
function turnUsageFromCodex(
  usage: {
    input_tokens: number;
    cached_input_tokens: number;
    output_tokens: number;
    reasoning_output_tokens: number;
  },
  model?: string,
): AgentTurnUsage | undefined {
  const input = positiveTokenCount(usage.input_tokens);
  const cached = positiveTokenCount(usage.cached_input_tokens);
  const output = positiveTokenCount(usage.output_tokens);
  if (input + output === 0) return undefined;
  return {
    ...(model ? { model } : {}),
    inputTokens: Math.max(0, input - cached),
    cachedInputTokens: cached,
    outputTokens: output,
    reasoningTokens: Math.min(
      output,
      positiveTokenCount(usage.reasoning_output_tokens),
    ),
  };
}

function mapEvent(event: ThreadEvent, model?: string): AgentEvent[] {
  switch (event.type) {
    case "item.started":
      if (event.item.type === "command_execution")
        return [
          {
            type: "command",
            content: event.item.command,
            status: "started",
            toolUseId: event.item.id,
          },
        ];
      if (event.item.type === "mcp_tool_call")
        return [
          {
            type: "tool_call",
            toolName: `${event.item.server}/${event.item.tool}`,
            toolUseId: event.item.id,
            toolInput: event.item.arguments,
            content: event.item.tool,
            status: "started",
          },
        ];
      return [];
    case "item.completed":
      return mapItemEvent(event.item);
    case "turn.completed": {
      const usage = turnUsageFromCodex(event.usage, model);
      return usage
        ? [{ type: "usage", usage }, { type: "done" }]
        : [{ type: "done" }];
    }
    case "turn.failed":
      return [
        { type: "error", content: event.error.message },
        { type: "done" },
      ];
    case "error":
      return [{ type: "diagnostic", content: event.message }];
    default:
      return [];
  }
}

function mapItemEvent(item: ThreadItem): AgentEvent[] {
  switch (item.type) {
    case "command_execution": {
      const events: AgentEvent[] = [
        {
          type: "command",
          content: `${item.command}\n${item.aggregated_output}`,
          toolUseId: item.id,
          status: "ended",
        },
      ];
      // A command that succeeded by daemonizing something left a process
      // running that Codex can no longer see or manage — flag it.
      if (item.exit_code === 0 && isDaemonizingCommand(item.command)) {
        events.push({
          type: "background",
          status: "detected",
          backgroundId: `codex-daemon-${item.id}`,
          content: item.command,
        });
      }
      return events;
    }
    case "file_change":
      // One event per changed file so host-execution change tracking (which
      // reads file_edit events) sees the whole patch, not just its first file.
      return item.changes.map((change) => ({
        type: "file_edit",
        filePath: change.path,
        content: change.kind,
      }));
    case "agent_message":
      return [{ type: "text", content: item.text }];
    case "mcp_tool_call": {
      // structured_content is what an MCP Apps view renders; fall back to
      // the result's text content for servers that only send text.
      const structured = item.result?.structured_content;
      const text = (item.result?.content ?? [])
        .map((block) =>
          "text" in block && typeof block.text === "string" ? block.text : "",
        )
        .filter(Boolean)
        .join("\n");
      return [
        {
          type: "tool_call",
          toolName: `${item.server}/${item.tool}`,
          toolInput: item.arguments,
          toolUseId: item.id,
          status: "ended",
          ...(structured !== undefined || text
            ? { toolResult: structured ?? text }
            : {}),
        },
      ];
    }
    case "web_search":
      return [
        {
          type: "tool_call",
          toolName: "web_search",
          toolInput: { query: item.query },
        },
      ];
    case "error":
      // Error items are diagnostics; an unsuccessful turn or incomplete
      // stream fails the turn.
      return [{ type: "diagnostic", content: item.message }];
    default:
      return [];
  }
}

/** Keep attachment bytes alive for the CLI turn, including resumed threads. */
async function stageTurnInput(text: string, attachments?: AgentAttachment[]) {
  const media = (attachments ?? []).filter((item) => item.kind !== "text");
  if (media.length === 0) return { input: text, cleanup: async () => {} };
  const directory = await mkdtemp(join(tmpdir(), "catamorphic-codex-input-"));
  const cleanup = () => rm(directory, { recursive: true, force: true });
  try {
    const input: UserInput[] = [{ type: "text", text }];
    for (const [index, item] of media.entries()) {
      const extensions: Record<string, string> = {
        "image/png": "png",
        "image/jpeg": "jpg",
        "image/webp": "webp",
        "image/gif": "gif",
        "application/pdf": "pdf",
      };
      const file = join(
        directory,
        `${index}.${extensions[item.mediaType] ?? "bin"}`,
      );
      await writeFile(file, Buffer.from(item.dataBase64, "base64"));
      if (item.kind === "image") {
        input.push({ type: "local_image", path: file });
      } else {
        input.push({
          type: "text",
          text: `Attached document ${JSON.stringify(item.name)} (${item.mediaType}) is available at ${JSON.stringify(file)} for this turn. Read it with your file or shell tools.`,
        });
      }
    }
    return { input, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
