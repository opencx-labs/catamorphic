import type {
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
  ToolPolicyAnnotations,
  TurnOptions,
} from "@catamorphic/sandbox";
import {
  buildPluginsPreamble,
  mergePolicyLayers,
  positiveTokenCount,
  renderUserMessage,
  resolveMcpServers,
  resolveToolPermissionAcross,
  stagePluginDocs,
} from "@catamorphic/sandbox";
import {
  Codex,
  type CodexOptions,
  type ThreadEvent,
  type ThreadItem,
  type ThreadOptions,
} from "@openai/codex-sdk";

type CodexConfigObject = NonNullable<CodexOptions["config"]>;

export interface CodexAgentOpts {
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
  /**
   * External MCP servers for this agent. Codex has no programmatic MCP
   * option, but its CLI accepts arbitrary `--config` overrides — the SDK
   * flattens these into `mcp_servers.<name>.*` keys, the same shape a
   * `config.toml` would carry. The CLI owns the connections and speaks
   * whatever protocol revision each server negotiates. Every turn spawns
   * a fresh CLI, so a getter (read per spawn) carries a rotated
   * credential to the next turn without a provider rebuild.
   */
  mcpServers?: McpServersSource;
  /** Host-owned MCP servers resolved for the current project/session. */
  mcpServersForSession?: (
    context: ExtraToolContext,
  ) => Record<string, AgentMcpServerConfig>;
  /**
   * Per-server tool permissions (see @catamorphic/sandbox tool-policy).
   * Codex offers no per-call approval channel to a host (its approvals
   * are the CLI's own prompts, and this harness runs with approvals off),
   * so the policy applies COARSELY at spawn: tools that resolve to `deny`
   * — and, failing closed, tools that would `ask` — are written to the
   * server's `disabled_tools`. Only tools named in the policy or in
   * {@link mcpToolAnnotations} can be resolved ahead of time; unknown
   * tools follow the default only when it is explicit.
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
 * Coding agent backed by the OpenAI Codex SDK. The Codex CLI runs on the
 * **host machine** and operates on a local working directory — use it when
 * the project checkout the agent should edit lives on the same filesystem
 * as the server (or when the host itself is the isolation boundary, e.g. a
 * CI runner). For agents that drive a remote dev sandbox, see
 * `@catamorphic/ai-sdk`.
 *
 * Sessions survive host restarts: the CLI persists threads under
 * `$CODEX_HOME/sessions`, and every turn resumes by thread id. Because each
 * turn spawns a fresh `codex exec resume`, per-turn model/effort overrides
 * apply cleanly via thread options.
 */
export class CodexAgent implements CodingAgentProvider {
  readonly name = "codex";
  private readonly opts: CodexAgentOpts;
  /**
   * Standing instructions for sessions whose thread hasn't started yet,
   * keyed by host chat session id. The CLI has no system-prompt channel, so
   * they ride with the first real user message; entries clear once the
   * thread exists (or on dispose). Recomputed by a fresh startSession when a
   * host restart drops them before the first turn ran.
   */
  private readonly pendingInstructions = new Map<string, string>();
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
  constructor(opts: CodexAgentOpts = {}) {
    this.opts = opts;
  }

  private buildClient(config: CodexOptions["config"] | undefined): Codex {
    return new Codex({
      apiKey: this.opts.apiKey,
      baseUrl: this.opts.baseUrl,
      codexPathOverride: this.opts.codexPathOverride,
      ...(config ? { config } : {}),
      // The SDK stops inheriting process.env once env is provided — merge
      // ourselves so PATH and friends survive alongside the overrides.
      ...(this.opts.env ? { env: mergedEnv(this.opts.env) } : {}),
    });
  }

  /**
   * The client a turn spawns through. A `Codex` is just spawn config, so
   * one is built per turn from the live sources — servers with their
   * current headers (a rotated token rides the next spawn), the
   * provider's policies narrowed by the session's caller (ADR 0055) —
   * with no provider rebuild and nothing to cache.
   */
  private clientFor(session: ProviderSession): Codex {
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
    const config = mcpServersConfig(
      {
        ...resolveMcpServers(this.opts.mcpServers),
        ...this.opts.mcpServersForSession?.(context),
        ...this.sessionMcpServers.get(session.sessionId),
      },
      mergePolicyLayers(own, this.callerPolicies.get(session.sessionId)),
      annotations,
    );
    return this.buildClient(config);
  }

  async startSession(opts: StartSessionOpts): Promise<ProviderSession> {
    await stagePluginDocs(opts.workingDirectory, opts.attachedPlugins);
    const preamble = buildPluginsPreamble(opts.attachedPlugins);
    const instructions = [preamble, opts.systemPrompt ?? ""]
      .filter(Boolean)
      .join("\n\n");
    if (instructions) {
      this.pendingInstructions.set(opts.sessionId, instructions);
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
    // Each turn spawns a fresh CLI run with this turn's options, so per-turn
    // model/effort overrides take effect without any in-memory thread state.
    // The first turn starts the thread; later turns resume it by id.
    if (opts?.toolPolicies) {
      this.callerPolicies.set(session.sessionId, opts.toolPolicies);
    }
    const client = this.clientFor(session);
    const threadOptions = this.threadOptions(session.workingDirectory, opts);
    const thread = session.providerSessionId
      ? client.resumeThread(session.providerSessionId, threadOptions)
      : client.startThread(threadOptions);
    // Codex takes no media, but text pills (pastes, selections, links,
    // tabs) are universal context — rendered the same as every harness.
    // omitMedia turns each media reference into a non-delivery note so the
    // model never hunts for bytes it was not given.
    const prose = renderUserMessage(message, opts?.attachments, {
      omitMedia: true,
    });
    const input = session.providerSessionId
      ? prose
      : this.withInstructions(session.sessionId, prose);

    let stream: AsyncIterable<ThreadEvent>;
    try {
      stream = (await thread.runStreamed(input)).events;
    } catch (error) {
      yield { type: "error", content: describeError(error) };
      yield { type: "done" };
      return;
    }

    // Codex gives the model no background-process tools, so watchers are
    // detected instead of intercepted: commands that daemonize something
    // (trailing "&", nohup, docker -d, …) and commands still running when
    // the turn ends both surface as "background" events.
    const runningCommands = new Map<string, string>();
    try {
      for await (const event of stream) {
        if (event.type === "thread.started" && !session.providerSessionId) {
          this.pendingInstructions.delete(session.sessionId);
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
    } catch (error) {
      yield { type: "error", content: describeError(error) };
      yield { type: "done" };
    }
  }

  async dispose(session: ProviderSession): Promise<void> {
    // Threads live on disk under $CODEX_HOME; nothing else to release.
    this.pendingInstructions.delete(session.sessionId);
    this.callerPolicies.delete(session.sessionId);
    this.sessionContexts.delete(session.sessionId);
    this.sessionMcpServers.delete(session.sessionId);
  }

  /**
   * Codex has no system-prompt channel, so standing instructions ride with
   * the thread's first user message inside a labeled block — attached to a
   * real turn, never a turn of their own.
   */
  private withInstructions(sessionId: string, message: string): string {
    const instructions = this.pendingInstructions.get(sessionId);
    if (!instructions) return message;
    return [
      "<session_instructions>",
      "Standing instructions for this session. The user's message follows after the closing tag.",
      "",
      instructions,
      "</session_instructions>",
      "",
      message,
    ].join("\n");
  }

  private threadOptions(
    workingDirectory: string,
    turn?: TurnOptions,
  ): ThreadOptions {
    const model = turn?.model ?? this.opts.model;
    const requested = turn?.effort ?? this.opts.effort;
    // Codex's reasoning scale tops out at xhigh; "max" clamps onto it.
    const effort = requested === "max" ? "xhigh" : requested;
    return {
      ...(workingDirectory ? { workingDirectory } : {}),
      skipGitRepoCheck: true,
      sandboxMode: this.opts.sandboxMode ?? "workspace-write",
      approvalPolicy: "never",
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
    };
  }
  return { mcp_servers: mcpServers };
}

/**
 * The Codex-side rendering of a policy: the same per-tool resolution the
 * shared `ToolGate` runs live in the other harnesses, applied once at
 * spawn because Codex has no per-call approval channel — ask fails closed.
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
    case "item.completed":
      return mapItemEvent(event.item);
    case "turn.completed": {
      const usage = turnUsageFromCodex(event.usage, model);
      return usage
        ? [{ type: "usage", usage }, { type: "done" }]
        : [{ type: "done" }];
    }
    case "turn.failed":
      return [{ type: "error", content: event.error.message }];
    case "error":
      return [{ type: "error", content: event.message }];
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
      return [{ type: "error", content: item.message }];
    default:
      return [];
  }
}
