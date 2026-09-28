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
  CodexApprovalPolicy,
  CodexSandboxMode,
  CodingAgentProvider,
  ExtraToolContext,
  McpServersSource,
  McpToolPolicyLayers,
  ProviderSession,
  SandboxModelGateway,
  StartSessionOpts,
  ToolPermissionHandler,
  ToolPolicyAnnotations,
  TurnOptions,
  TurnSandbox,
} from "@catamorphic/sandbox";
import {
  buildPluginsPreamble,
  listenAgentCapabilityGateway,
  mergePolicyLayers,
  positiveTokenCount,
  reasoningHeading,
  renderUserMessage,
  resolveMcpServers,
  resolveToolPermissionAcross,
  spawnInSandbox,
  stagedPluginFiles,
  stagePluginDocs,
  transcriptHistoryPreamble,
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
  type CodexAppServerSpawn,
  type CodexElicitation,
  type CodexElicitationResult,
} from "./app-server.js";

type CodexConfigObject = NonNullable<CodexOptions["config"]>;

export interface CodexAgentOpts {
  /** Host-owned plugin reference directory; defaults to the working directory. */
  pluginDirectory?: string;
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
   * Codex's own OS-level sandbox policy (ADR 0182), unless a turn names its
   * own (`TurnOptions.harnessPermissions.sandbox`). Defaults to
   * "workspace-write" on the host, the CLI's designed unattended mode: free
   * rein inside the working directory, everything else read-only. Inside a
   * Work sandbox the default is "danger-full-access" (see `sandbox`).
   */
  sandboxMode?: CodexSandboxMode;
  /**
   * When Codex asks before acting (ADR 0182), unless a turn names its own
   * (`TurnOptions.harnessPermissions.approvals`). Defaults to "on-request"
   * when the host can answer (`onToolPermission` or
   * `mcpElicitationForSession`), else "never".
   */
  approvalPolicy?: CodexApprovalPolicy;
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
  /**
   * Run the app server inside each turn's sandbox instead of on this host
   * (ADR 0180). The host passes the sandbox and the model gateway on every
   * turn; the app server's standard input and output travel over sandbox
   * process operations. `command` is the CLI in the sandbox image (default
   * `codex`). Its model provider is the gateway, authenticated by a command
   * that reads the session's current grant file; no host variable reaches
   * it. A turn carrying the owner's own login (`TurnOptions.personalLogin`,
   * ADR 0184) runs with `CODEX_HOME` at that login and Codex's own OpenAI
   * provider instead of the gateway. Codex's own OS sandbox is off there: the Work sandbox is the
   * boundary, and modes are enforced where changes leave it (ADR 0176).
   */
  sandbox?: { command?: string };
}

/**
 * Where a sandbox-resident turn runs and how it reaches its model: through
 * the gateway with the session's grant (ADR 0180), or directly with the
 * owner's own login in `CODEX_HOME` (ADR 0184).
 */
interface SandboxRun {
  sandbox: TurnSandbox;
  auth:
    | { kind: "gateway"; gateway: SandboxModelGateway }
    | { kind: "personal"; home: string };
  command: string;
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
    session: ProviderSession,
    sandboxRun?: SandboxRun,
  ): CodexAppServer {
    const sessionId = session.sessionId;
    if (sandboxRun) {
      return new CodexAppServer(
        {
          codexPathOverride: sandboxRun.command,
          config: {
            ...config,
            ...(sandboxRun.auth.kind === "gateway"
              ? gatewayProviderConfig(sandboxRun.auth.gateway)
              : {}),
          },
        },
        this.opts.mcpElicitationForSession?.({ sessionId }),
        this.opts.onToolPermission,
        sessionId,
        sandboxSpawn({ run: sandboxRun, cwd: session.workingDirectory }),
      );
    }
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
    sandboxRun?: SandboxRun,
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
    // A new sandbox or model endpoint needs a new app server there.
    const signature = JSON.stringify({
      config,
      ...(sandboxRun
        ? {
            sandboxId: sandboxRun.sandbox.sandboxId,
            model:
              sandboxRun.auth.kind === "gateway"
                ? sandboxRun.auth.gateway.baseUrl
                : `personal:${sandboxRun.auth.home}`,
          }
        : {}),
    });
    const existing = this.clients.get(session.sessionId);
    if (existing?.client.available && existing.signature === signature) {
      existing.client.setContext(contextPrompt);
      return existing.client;
    }
    existing?.client.close();
    const client = this.buildClient(config, session, sandboxRun);
    client.setContext(contextPrompt);
    this.clients.set(session.sessionId, { signature, client });
    return client;
  }

  /** Per session: the sandbox directory last resolved, and its answer. */
  private readonly sandboxDirectories = new Map<
    string,
    { sandboxId: string; directory: string; resolved: string }
  >();

  /**
   * The working directory as the sandbox's own processes name it. Codex
   * receives it over its protocol, not as its process's cwd, so a provider
   * that maps the virtual `/workspace` onto a host folder (local-process)
   * must hand Codex the mapped path; a VM answers `/workspace` itself.
   */
  private async sandboxDirectory(input: {
    sessionId: string;
    run: SandboxRun;
    directory: string;
  }): Promise<string> {
    const { run, directory } = input;
    const sandboxId = run.sandbox.sandboxId;
    const known = this.sandboxDirectories.get(input.sessionId);
    if (known?.sandboxId === sandboxId && known.directory === directory)
      return known.resolved;
    const { exitCode, result } = await run.sandbox.provider.executeCommand(
      sandboxId,
      "pwd -P",
      { cwd: directory },
    );
    const resolved = result.trim();
    if (exitCode !== 0 || !resolved.startsWith("/")) return directory;
    this.sandboxDirectories.set(input.sessionId, {
      sandboxId,
      directory,
      resolved,
    });
    return resolved;
  }

  async startSession(opts: StartSessionOpts): Promise<ProviderSession> {
    if (this.opts.sandbox) {
      // The working directory is the sandbox's: plugin docs go there.
      const files = stagedPluginFiles(opts.attachedPlugins);
      if (opts.sandboxProvider && Object.keys(files).length > 0)
        await opts.sandboxProvider.uploadFiles(
          opts.sandboxId,
          files,
          this.opts.pluginDirectory ?? opts.workingDirectory,
        );
    } else {
      await stagePluginDocs(
        this.opts.pluginDirectory ?? opts.workingDirectory,
        opts.attachedPlugins,
      );
    }
    const preamble = buildPluginsPreamble(opts.attachedPlugins, {
      directory: this.opts.pluginDirectory,
    });
    const instructions = [
      preamble,
      opts.systemPrompt ?? "",
      // A sandbox-resident session re-anchored in a new sandbox has no
      // thread there: it continues from the host's transcript.
      this.opts.sandbox ? transcriptHistoryPreamble(opts.history) : "",
    ]
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
      if (this.opts.sandbox) {
        const run = sandboxRunFor(this.opts.sandbox, opts);
        if (typeof run === "string") {
          yield { type: "error", content: run };
          yield { type: "done" };
          return;
        }
        // The capability listener serves this host's loopback, which a
        // sandbox cannot reach; capabilities stay with in-process harnesses
        // until they travel over the app-server protocol.
        yield* this.sendMessageOnHost(session, message, opts, undefined, run);
        return;
      }
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
    sandboxRun?: SandboxRun,
  ): AsyncIterable<AgentEvent> {
    // Native turn options refresh while MCP processes survive between turns.
    if (opts?.toolPolicies) {
      this.callerPolicies.set(session.sessionId, opts.toolPolicies);
    }
    // Session instructions are stable developer instructions; the turn's
    // context travels separately on turn/start (ADR 0152).
    const client = this.clientFor(
      session,
      capabilityServer,
      this.sessionInstructions.get(session.sessionId),
      sandboxRun,
    );
    const threadOptions = this.threadOptions(
      sandboxRun
        ? await this.sandboxDirectory({
            sessionId: session.sessionId,
            run: sandboxRun,
            directory: session.workingDirectory,
          })
        : session.workingDirectory,
      opts,
      sandboxRun !== undefined,
    );
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
      // Media files would be written on this host; a sandbox turn sends
      // the text (attachments are named in it).
      staged = sandboxRun
        ? { input: text, cleanup: async () => {} }
        : await stageTurnInput(text, opts?.attachments);
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
    this.sandboxDirectories.delete(session.sessionId);
  }

  private clearAbortController(controller: AbortController): void {
    for (const [key, current] of this.turnAbortControllers) {
      if (current === controller) this.turnAbortControllers.delete(key);
    }
  }

  private threadOptions(
    workingDirectory: string,
    turn: TurnOptions | undefined,
    inSandbox: boolean,
  ): ThreadOptions {
    const model = turn?.model ?? this.opts.model;
    const effort = turn?.effort ?? this.opts.effort;
    return {
      ...(workingDirectory ? { workingDirectory } : {}),
      skipGitRepoCheck: true,
      sandboxMode:
        turn?.harnessPermissions?.sandbox ??
        this.opts.sandboxMode ??
        (inSandbox ? "danger-full-access" : "workspace-write"),
      approvalPolicy:
        turn?.harnessPermissions?.approvals ??
        this.opts.approvalPolicy ??
        (this.opts.mcpElicitationForSession || this.opts.onToolPermission
          ? "on-request"
          : "never"),
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

/** How often Codex re-reads its key: grants are renewed every 20 minutes. */
const KEY_REFRESH_MS = 5 * 60_000;

/**
 * The sandbox and model a sandbox-resident turn needs, or why it cannot
 * run (ADR 0180).
 */
function sandboxRunFor(
  options: { command?: string },
  turn: TurnOptions | undefined,
): SandboxRun | string {
  if (!turn?.sandbox?.provider.processes)
    return "Codex runs inside this chat's sandbox, and this Environment's sandboxes cannot run it (they do not run processes).";
  const command = options.command ?? "codex";
  if (turn.personalLogin?.harness === "codex")
    return {
      sandbox: turn.sandbox,
      auth: { kind: "personal", home: turn.personalLogin.home },
      command,
    };
  const gateway = turn.modelGateway;
  if (!gateway)
    return "Codex reaches its model through the gateway, and this chat has no model connection: bind one in the agent's Environment and name it in the agent's credentials.";
  if (gateway.api !== "openai")
    return `Codex speaks the OpenAI API; the connection '${gateway.alias}' is an ${gateway.api} API.`;
  return { sandbox: turn.sandbox, auth: { kind: "gateway", gateway }, command };
}

/**
 * Path variables of the app server in the sandbox: the gateway grant file,
 * or `CODEX_HOME` holding the owner's own `auth.json` (ADR 0184).
 */
export function sandboxPathEnv(run: {
  auth: SandboxRun["auth"];
}): Record<string, string> {
  return run.auth.kind === "gateway"
    ? { WORK_MODEL_KEY_FILE: run.auth.gateway.keyFile }
    : { CODEX_HOME: run.auth.home };
}

/**
 * Codex's model provider for a sandbox turn: the gateway's Responses API,
 * authenticated by a command that prints the session's current grant.
 */
export function gatewayProviderConfig(
  gateway: SandboxModelGateway,
): CodexConfigObject {
  return {
    model_provider: "work",
    model_providers: {
      work: {
        name: "Work gateway",
        base_url: gateway.baseUrl,
        wire_api: "responses",
        auth: {
          command: "sh",
          args: ["-c", 'cat "$WORK_MODEL_KEY_FILE"'],
          refresh_interval_ms: KEY_REFRESH_MS,
        },
      },
    },
  };
}

/** The app server's spawn, carried out in the sandbox over process operations. */
function sandboxSpawn(input: {
  run: SandboxRun;
  cwd: string;
}): CodexAppServerSpawn {
  const { run } = input;
  return ({ command, args, env }) => {
    const processes = run.sandbox.provider.processes;
    if (!processes) throw new Error("This sandbox cannot run processes");
    const stderr = `${run.sandbox.stateDirectory}/codex.stderr`;
    return spawnInSandbox({
      processes,
      sandboxId: run.sandbox.sandboxId,
      command,
      args,
      cwd: input.cwd || run.sandbox.stateDirectory,
      env,
      pathEnv: sandboxPathEnv(run),
      stderrPath: stderr,
      name: "Codex",
      readStderr: async () =>
        (
          await run.sandbox.provider.executeCommand(
            run.sandbox.sandboxId,
            `tail -c 4000 ${JSON.stringify(stderr)} 2>/dev/null || true`,
          )
        ).result,
    });
  };
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
            ...describedBy(event.item.arguments),
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
    case "command_execution":
      return [
        {
          type: "command",
          content: `${item.command}\n${item.aggregated_output}`,
          toolUseId: item.id,
          status: "ended",
        },
      ];
    case "reasoning": {
      // Codex's reasoning summaries open with a bold heading ("**Reviewing
      // database migrations**"): the agent's own words for what it is
      // doing, which is exactly the live status line.
      const heading = reasoningHeading(item.text);
      return heading ? [{ type: "status", content: heading }] : [];
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

/** A tool call's own `description` argument, when the agent wrote one. */
function describedBy(args: unknown): { description?: string } {
  const description =
    typeof args === "object" && args !== null && "description" in args
      ? (args as { description?: unknown }).description
      : undefined;
  return typeof description === "string" && description ? { description } : {};
}
