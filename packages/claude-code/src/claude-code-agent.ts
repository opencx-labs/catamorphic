import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  type CanUseTool,
  createSdkMcpServer,
  type HookCallback,
  type McpServerConfig,
  type Options,
  type PermissionResult,
  query,
  type SDKMessage,
  tool as sdkTool,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentEffort,
  AgentEvent,
  AgentMcpServerConfig,
  AgentPluginConfig,
  AgentQuestion,
  CodingAgentProvider,
  ExtraTool,
  ExtraToolContext,
  McpToolPolicyLayers,
  ProviderSession,
  StartSessionOpts,
  ToolPermissionHandler,
  ToolPolicyAnnotations,
  TurnOptions,
} from "@catamorphic/sandbox";
import {
  buildPluginsPreamble,
  isMediaAttachment,
  renderTextAttachments,
  resolveToolPermissionAcross,
  stagePluginDocs,
} from "@catamorphic/sandbox";
import type { ZodRawShape } from "zod";

export interface ClaudeCodeAgentOpts {
  /** Default model for sessions (e.g. "claude-sonnet-4-5"). */
  model?: string;
  /** Default reasoning effort; maps to the SDK's `effort` level. */
  effort?: AgentEffort;
  /**
   * Extra environment for the spawned CLI (e.g. `CLAUDE_CONFIG_DIR` for
   * per-account credential isolation, `ANTHROPIC_API_KEY`). Merged over
   * `process.env` — the SDK's `env` option replaces the subprocess
   * environment entirely, so the merge happens here.
   */
  env?: Record<string, string>;
  /**
   * JS runtime used to run the CLI. The SDK auto-detects when omitted;
   * Electron hosts that ship their own node pass "node" here plus
   * `executableArgs` / `pathToClaudeCodeExecutable` as needed.
   */
  executable?: "bun" | "deno" | "node";
  /** Additional arguments for the JS runtime executable. */
  executableArgs?: string[];
  /** Override the path to the Claude Code executable itself. */
  pathToClaudeCodeExecutable?: string;
  /**
   * Host-supplied tools offered to Claude Code as an in-process MCP server
   * named "workspace" (tool ids `mcp__workspace__<name>`), pre-approved in
   * the allowlist. This is how the desktop app hands Claude Code its
   * embedded browser and terminals — the SDK's native tool-use loop drives
   * them like any other MCP server.
   */
  extraTools?: ExtraTool[];
  /**
   * Swap the built-in shell-execution tools (Bash, and its siblings
   * PowerShell and Monitor) for the host's terminal tools. Claude Code's
   * own shell runs inside the CLI process where the host can't see or
   * manage it; hosts that provide terminal tools via {@link extraTools}
   * disable the built-ins so every command runs through terminals the
   * host fully intercepts (and the user can watch and take over).
   *
   * Per-turn, not absolute: on turns where the workspace server is not
   * mounted (sessions resurrected after a host restart run without host
   * context), the built-in shell tools come back — an agent must never
   * be left with no way to run commands at all. Background-task
   * follow/stop tools (TaskOutput/TaskStop) stay available either way —
   * with Bash disabled they still manage background subagents.
   */
  disableBash?: boolean;
  /**
   * External MCP servers for this agent (the host's resolved connection
   * set). Passed to the CLI as native `mcpServers` config and allowlisted
   * server-wide; the CLI negotiates protocol versions with each server
   * itself.
   */
  mcpServers?: Record<string, AgentMcpServerConfig>;
  /**
   * Session-scoped MCP servers, resolved from the session's project —
   * how a host mounts per-project surfaces (e.g. Catamorphic's workflow
   * tools endpoint) beside the agent-wide {@link mcpServers}. Resolved on
   * every turn; sessions resurrected without host context (after a host
   * restart) run without them, like {@link extraTools}.
   */
  mcpServersForSession?: (
    context: ExtraToolContext,
  ) => Record<string, AgentMcpServerConfig>;
  /**
   * Installed connector plugins, loaded natively (commands, agents,
   * skills, hooks). MCP discovery inside the plugin is disabled — the
   * host lifts a plugin's MCP servers into {@link mcpServers} so every
   * harness gets them, not just this one.
   */
  plugins?: AgentPluginConfig[];
  /**
   * Per-server tool permissions (see @catamorphic/sandbox tool-policy).
   * A server with an entry loses its server-wide allowlist entry; each of
   * its tools then routes through `canUseTool`, where the policy decides:
   * allow, deny (with a message the model reads), or ask the host via
   * {@link onToolPermission}. Servers without an entry stay pre-approved.
   */
  mcpPolicies?:
    | Record<string, McpToolPolicyLayers>
    | (() => Record<string, McpToolPolicyLayers>);
  /**
   * Tool annotations per server (tool name → hints), for `auto` policies:
   * the CLI's permission callback carries no annotations, so the host
   * supplies what it learned when it last listed the server's tools.
   * Both accept a getter so edits apply live (no provider rebuild).
   */
  mcpToolAnnotations?:
    | Record<string, Record<string, ToolPolicyAnnotations>>
    | (() => Record<string, Record<string, ToolPolicyAnnotations>>);
  /** How to ask the user about an `ask` tool; omitted = ask fails closed. */
  onToolPermission?: ToolPermissionHandler;
}

/**
 * Tools the harness lets Claude Code use without prompting. Everything else
 * is routed through {@link denyUnlistedTools} and rejected — the desktop
 * product runs unattended, so there is no one to answer a permission prompt.
 */
const ALLOWED_TOOLS = [
  "Bash",
  // Bash's shell-execution siblings: PowerShell (native on Windows,
  // opt-in elsewhere) and Monitor (watch a command/WebSocket and feed
  // lines back as events). They ride the same interception switch as
  // Bash — see SHELL_EXECUTION_TOOLS.
  "PowerShell",
  "Monitor",
  "Read",
  "Glob",
  "Grep",
  "Edit",
  "Write",
  "WebSearch",
  "WebFetch",
  "TodoWrite",
  "NotebookEdit",
  // Plugins ship skills and slash commands; the tools that invoke them
  // must be callable or the plugin content is unreachable.
  "Skill",
  "SlashCommand",
  // The subagent tool — "Task" in older CLIs, renamed "Agent" in 2.1.x.
  "Task",
  "Agent",
  // Background-task management: follow output / stop. Newer CLIs use
  // TaskOutput/TaskStop; BashOutput/KillShell are the legacy names.
  "TaskOutput",
  "TaskStop",
  "BashOutput",
  "KillShell",
  // AskUserQuestion is deliberately NOT listed: its permission check must
  // reach canUseTool, where the harness parks the call and surfaces the
  // questions to the user (see buildOptions). Allowlisting it would let
  // the tool run with no answers at all.
];

/**
 * Tools that execute commands inside the CLI process, invisible to the
 * host. When the host mounts its own terminal tools ({@link
 * ClaudeCodeAgentOpts.disableBash}), these are removed from the model's
 * context entirely (`disallowedTools`, not just a call-time deny) so the
 * model reaches for the workspace terminals instead of a tool it can see
 * but never use.
 */
const SHELL_EXECUTION_TOOLS = new Set(["Bash", "PowerShell", "Monitor"]);

/** Tool names whose invocations are surfaced as `file_edit` events. */
const FILE_EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** Both generations of the subagent tool's name. */
const SUBAGENT_TOOLS = new Set(["Task", "Agent"]);

/** Both generations of the stop-background-task tool's name. */
const TASK_STOP_TOOLS = ["TaskStop", "KillShell"];

/**
 * Permission fallback for tools outside {@link ALLOWED_TOOLS}: deny with a
 * reason the model can read, instead of hanging on a prompt nobody will see.
 * Shell-execution tools get a redirect, not a dead end — a model that
 * reaches for Bash (an old transcript, a subagent) should land on the
 * workspace terminals, not conclude it cannot run commands.
 */
const denyUnlistedTools: CanUseTool = async (toolName) => ({
  behavior: "deny",
  message: SHELL_EXECUTION_TOOLS.has(toolName)
    ? "Built-in shell tools are disabled here. Run commands with the " +
      "workspace terminal tools instead: run_terminal executes a command " +
      "in a visible terminal tab (read_terminal follows it, write_terminal " +
      "answers prompts)."
    : "This tool is not available in the Catamorphic desktop harness.",
});

interface SessionState {
  systemPrompt?: string;
  workingDirectory: string;
  /** Context handed to extra (workspace) tools at execution time. */
  toolContext?: ExtraToolContext;
  /**
   * False until the CLI has confirmed the session exists on disk (its init
   * message on the first real turn). Until then, queries pass `sessionId`
   * (create with our chosen UUID); after, they pass `resume`.
   */
  transcriptExists: boolean;
}

/**
 * One CLI query's live stream and the per-query state that must survive an
 * AskUserQuestion pause. The CLI's native ask-the-user tool routes through
 * `canUseTool`; the harness parks that promise, ends the current turn with
 * a `question` event (core persists it as `awaiting_input`, the host shows
 * its question panel), and keeps the stream here. The user's next message
 * resolves the parked promise with their answers — the tool RETURNS them —
 * and the same stream keeps flowing in the answer turn.
 */
interface LiveTurn {
  /** The query's message stream; never closed while an ask is parked. */
  iterator?: AsyncIterator<SDKMessage>;
  /**
   * In-flight `next()` carried across the ask boundary: the promise raced
   * against the ask signal is still pending when the turn parks, and the
   * answer turn must keep waiting on it, not queue a second read.
   */
  nextPending?: Promise<IteratorResult<SDKMessage>>;
  /** Events from SDK hooks, drained between stream messages. */
  hookEvents: AgentEvent[];
  /** Subagents this query spawned, keyed by their Task tool-use id. */
  openSubagents: Set<string>;
  abort: AbortController;
  state?: SessionState;
  /** The parked AskUserQuestion call: its input and its answer resolver. */
  ask?: {
    input: Record<string, unknown>;
    resolve: (result: PermissionResult) => void;
  };
  /** Settles when an AskUserQuestion call parks; re-armed per ask. */
  askRaised: Promise<void>;
  raiseAsk: () => void;
}

function createLiveTurn(state: SessionState | undefined): LiveTurn {
  const live: Partial<LiveTurn> = {
    hookEvents: [],
    openSubagents: new Set<string>(),
    abort: new AbortController(),
    state,
  };
  armAskSignal(live as LiveTurn);
  return live as LiveTurn;
}

/** Fresh one-shot signal for the next AskUserQuestion park. */
function armAskSignal(live: LiveTurn): void {
  live.askRaised = new Promise<void>((resolve) => {
    live.raiseAsk = resolve;
  });
}

/**
 * Coding agent backed by the official Claude Agent SDK. The Claude Code CLI
 * runs on the **host machine** and operates on a local working directory —
 * use it when the project checkout the agent should edit lives on the same
 * filesystem as the server. Per-account credential isolation is done through
 * `env.CLAUDE_CONFIG_DIR`: each account gets its own config directory, so
 * credentials and session transcripts never mix. Sessions survive host
 * restarts — `resume` replays the CLI's persisted transcript, so a session
 * unknown to the in-memory map still works (the combined system prompt is
 * simply not re-sent; the resumed transcript already carries its context).
 * For agents that drive a remote dev sandbox, see `@catamorphic/ai-sdk`.
 */
export class ClaudeCodeAgent implements CodingAgentProvider {
  readonly name = "claude-code";
  private readonly opts: ClaudeCodeAgentOpts;
  private readonly sessions = new Map<string, SessionState>();
  private readonly activeAborts = new Map<string, AbortController>();
  /**
   * Sessions whose last turn parked on an AskUserQuestion call: the query
   * is still alive, blocked on the parked `canUseTool` promise, and the
   * next sendMessage resumes it with the user's answers.
   */
  private readonly awaitingAnswers = new Map<string, LiveTurn>();

  constructor(opts?: ClaudeCodeAgentOpts) {
    this.opts = opts ?? {};
  }

  async startSession(opts: StartSessionOpts): Promise<ProviderSession> {
    await stagePluginDocs(opts.workingDirectory, opts.attachedPlugins);
    const preamble = buildPluginsPreamble(opts.attachedPlugins);
    const systemPrompt =
      [preamble, opts.systemPrompt ?? ""].filter(Boolean).join("\n\n") ||
      undefined;

    const toolContext: ExtraToolContext = {
      projectId: opts.projectId,
      sessionId: opts.sessionId,
    };

    // No kickoff turn: we choose the session id ourselves and hand it to the
    // CLI via `options.sessionId` on the first real turn. Anything else would
    // put a synthetic user message at the top of the transcript, and the
    // model treats it as a standing instruction.
    const sessionId = crypto.randomUUID();

    this.sessions.set(sessionId, {
      systemPrompt,
      workingDirectory: opts.workingDirectory,
      toolContext,
      transcriptExists: false,
    });

    return {
      providerSessionId: sessionId,
      sessionId: opts.sessionId,
      projectId: opts.projectId,
      sandboxId: opts.sandboxId,
      workingDirectory: opts.workingDirectory,
    };
  }

  /** Abort the in-flight turn; the stream settles with an error event. */
  interrupt(providerSessionId: string): void {
    this.activeAborts.get(providerSessionId)?.abort();
  }

  async *sendMessage(
    session: ProviderSession,
    message: string,
    opts?: TurnOptions,
  ): AsyncIterable<AgentEvent> {
    // This provider chooses its session ids in startSession, so a null id
    // here is a host bug, not a state this harness can be in.
    const providerSessionId = session.providerSessionId;
    if (!providerSessionId) {
      yield {
        type: "error",
        content: "Claude Code session was never given a session id.",
      };
      yield { type: "done" };
      return;
    }
    // An answer to a parked AskUserQuestion resumes the live query: the
    // parked canUseTool promise resolves with the user's answers, the tool
    // returns them, and the model continues on the SAME stream — this
    // (answer) turn simply keeps draining it.
    const awaiting = this.awaitingAnswers.get(providerSessionId);
    if (awaiting) {
      this.awaitingAnswers.delete(providerSessionId);
      const ask = awaiting.ask;
      awaiting.ask = undefined;
      armAskSignal(awaiting);
      ask?.resolve({
        behavior: "allow",
        updatedInput: askUserAnswerInput(ask.input, message),
      });
      yield* this.pumpTurn(providerSessionId, awaiting);
      return;
    }

    const state = this.sessions.get(providerSessionId);
    const cwd =
      session.workingDirectory || state?.workingDirectory || undefined;

    const live = createLiveTurn(state);
    try {
      // A session we created but never ran creates its transcript now, under
      // the id chosen in startSession; everything else (later turns, sessions
      // resurrected after a host restart) resumes the persisted transcript.
      const anchor =
        state && !state.transcriptExists
          ? { sessionId: providerSessionId }
          : { resume: providerSessionId };
      const turn = query({
        prompt: await withAttachments(
          message,
          opts?.attachments,
          providerSessionId,
        ),
        options: {
          ...this.buildOptions(
            cwd,
            state?.systemPrompt,
            state?.toolContext,
            opts,
            live,
          ),
          ...anchor,
          abortController: live.abort,
        },
      });
      live.iterator = turn[Symbol.asyncIterator]();
    } catch (error) {
      yield {
        type: "error",
        content: error instanceof Error ? error.message : String(error),
      };
      yield { type: "done" };
      return;
    }
    yield* this.pumpTurn(providerSessionId, live);
  }

  /**
   * Drain the query's stream into agent events. When an AskUserQuestion
   * call parks (the CLI is blocked on its permission promise, so no more
   * messages can arrive), the turn settles as a question: `question` +
   * `done`, and the still-open stream is stashed for the answer turn. The
   * iterator is deliberately never closed on that early return — a
   * `for await` exit would call `return()` and kill the mid-turn CLI.
   */
  private async *pumpTurn(
    providerSessionId: string,
    live: LiveTurn,
  ): AsyncIterable<AgentEvent> {
    this.activeAborts.set(providerSessionId, live.abort);
    let done = false;
    try {
      while (live.iterator) {
        live.nextPending ??= live.iterator.next();
        const winner = await Promise.race([
          live.nextPending.then(() => "message" as const),
          live.askRaised.then(() => "ask" as const),
        ]);
        if (winner === "ask") {
          yield* live.hookEvents.splice(0);
          yield {
            type: "question",
            questions: parseAskUserQuestions(live.ask?.input),
          };
          yield { type: "done" };
          done = true;
          this.awaitingAnswers.set(providerSessionId, live);
          return;
        }
        const next = await live.nextPending;
        live.nextPending = undefined;
        if (next.done) break;
        const sdkMessage = next.value;
        // The init message means the CLI booted and owns the transcript;
        // from here on this session must be resumed, never re-created.
        if (live.state && sdkMessage.type === "system") {
          live.state.transcriptExists = true;
        }
        yield* live.hookEvents.splice(0);
        for (const event of mapMessage(sdkMessage, live.openSubagents)) {
          if (event.type === "done") done = true;
          yield event;
        }
      }
      yield* live.hookEvents.splice(0);
    } catch (error) {
      // Spawn/auth/stream failures surface as events, mirroring CodexAgent —
      // consumers iterate the stream and must never see a mid-iteration throw.
      if (!done) {
        yield {
          type: "error",
          content: error instanceof Error ? error.message : String(error),
        };
        yield { type: "done" };
      }
    } finally {
      this.activeAborts.delete(providerSessionId);
    }
  }

  async dispose(session: ProviderSession): Promise<void> {
    if (!session.providerSessionId) return;
    // interrupt() only exists in streaming-input mode; string prompts are
    // cancelled via the per-send AbortController instead.
    this.activeAborts.get(session.providerSessionId)?.abort();
    this.activeAborts.delete(session.providerSessionId);
    // A query parked on an unanswered question must not outlive the
    // session: unblock the CLI (deny) and abort the stream.
    const awaiting = this.awaitingAnswers.get(session.providerSessionId);
    if (awaiting) {
      this.awaitingAnswers.delete(session.providerSessionId);
      awaiting.ask?.resolve({
        behavior: "deny",
        message: "The session was closed before the user answered.",
        interrupt: true,
      });
      awaiting.ask = undefined;
      awaiting.abort.abort();
    }
    this.sessions.delete(session.providerSessionId);
  }

  /**
   * Options shared by every query for a session: host cwd, merged env,
   * executable overrides, unattended permissions, and the model/effort
   * defaults with per-turn overrides applied.
   */
  /** "Always allow" answers, remembered for this provider's lifetime. */
  private readonly rememberedTools = new Set<string>();

  private currentPolicies(): Record<string, McpToolPolicyLayers> | undefined {
    const source = this.opts.mcpPolicies;
    return typeof source === "function" ? source() : source;
  }

  private currentAnnotations(): Record<
    string,
    Record<string, ToolPolicyAnnotations>
  > {
    const source = this.opts.mcpToolAnnotations;
    return (typeof source === "function" ? source() : source) ?? {};
  }

  /**
   * The policy verdict for an external MCP tool call, or undefined when
   * the tool isn't one of the policed servers' (built-ins, workspace, and
   * unpoliced servers fall through to the allowlist rules).
   */
  private async policedMcpDecision(
    toolName: string,
    input: Record<string, unknown>,
    sessionId?: string,
  ): Promise<PermissionResult | undefined> {
    const policies = this.currentPolicies();
    if (!policies || !toolName.startsWith("mcp__")) return undefined;
    const annotations = this.currentAnnotations();
    // Longest server key wins: "mcp__foo__bar__tool" is server "foo__bar"
    // if that server exists.
    const server = Object.keys(policies)
      .filter((name) => toolName.startsWith(`mcp__${name}__`))
      .sort((a, b) => b.length - a.length)[0];
    if (!server) return undefined;
    const tool = toolName.slice(`mcp__${server}__`.length);
    const key = `${server}\u0000${tool}`;
    const permission = resolveToolPermissionAcross(
      policies[server],
      tool,
      annotations[server]?.[tool],
    );
    if (permission === "allow") return { behavior: "allow" };
    // A remembered "always allow" only short-circuits the ASK — a later
    // Off in the editor still wins (policies are read live).
    if (permission === "ask" && this.rememberedTools.has(key)) {
      return { behavior: "allow" };
    }
    if (permission === "deny") {
      return {
        behavior: "deny",
        message: `The tool "${tool}" on ${server} is turned off in this connection's permissions.`,
      };
    }
    const ask = this.opts.onToolPermission;
    if (!ask) {
      return {
        behavior: "deny",
        message: `The tool "${tool}" on ${server} needs the user's permission, and there is no one to ask in this context.`,
      };
    }
    const answer = await ask({
      ...(sessionId ? { sessionId } : {}),
      server,
      tool,
      input,
      annotations: annotations[server]?.[tool],
    });
    if (answer.decision === "deny") {
      return {
        behavior: "deny",
        message: `The user declined to let you use "${tool}" on ${server} for this call.`,
      };
    }
    if (answer.remember === "always") this.rememberedTools.add(key);
    return { behavior: "allow" };
  }

  private buildOptions(
    cwd: string | undefined,
    systemPrompt: string | undefined,
    toolContext: ExtraToolContext | undefined,
    turn: TurnOptions | undefined,
    live: LiveTurn,
  ): Options {
    // Sessions resumed after a host restart have no stored context to run
    // extra tools with, so they run without the workspace server (the CLI
    // transcript survives; the tools return once the state is known again).
    const extraTools = toolContext ? (this.opts.extraTools ?? []) : [];
    const workspaceServer =
      extraTools.length > 0 && toolContext
        ? createSdkMcpServer({
            name: "workspace",
            version: "1.0.0",
            tools: extraTools.map((def) =>
              sdkTool(
                def.name,
                def.description,
                def.parameters as ZodRawShape,
                async (args) => {
                  try {
                    const result = await def.execute(
                      args as Record<string, unknown>,
                      toolContext,
                    );
                    return {
                      content: [
                        { type: "text", text: stringifyToolResult(result) },
                      ],
                    };
                  } catch (error) {
                    return {
                      content: [
                        {
                          type: "text",
                          text:
                            error instanceof Error
                              ? error.message
                              : String(error),
                        },
                      ],
                      isError: true,
                    };
                  }
                },
              ),
            ),
          })
        : undefined;

    // Shell interception is per-turn: only swap the built-in shell tools
    // out when the workspace terminals are actually mounted to replace
    // them. A session resurrected without host context keeps Bash — an
    // agent with no way to run commands at all is broken, not safe.
    const shellToolsDisabled =
      Boolean(this.opts.disableBash) && workspaceServer !== undefined;

    // Session-scoped servers win a name clash with the agent-wide set:
    // the host owns both maps and picks the session keys, so a collision
    // means it chose to shadow (e.g. a per-project "catamorphic" server).
    const externalServers = mapMcpServers({
      ...this.opts.mcpServers,
      ...(toolContext
        ? this.opts.mcpServersForSession?.(toolContext)
        : undefined),
    });

    return {
      cwd,
      // Ride the claude_code preset and APPEND the host's instructions: the
      // harness is a real Claude Code shell, so sessions keep the CLI's own
      // system prompt (tone, tool doctrine, dev conventions) instead of
      // replacing it with only the host paragraphs.
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        ...(systemPrompt ? { append: systemPrompt } : {}),
      },
      env: { ...process.env, ...this.opts.env },
      executable: this.opts.executable,
      executableArgs: this.opts.executableArgs,
      pathToClaudeCodeExecutable: this.opts.pathToClaudeCodeExecutable,
      model: turn?.model ?? this.opts.model,
      effort: turn?.effort ?? this.opts.effort,
      permissionMode: "acceptEdits",
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
            // MCP discovery off: the host lifts plugin MCP servers into
            // mcpServers itself so all harnesses share the connections.
            plugins: this.opts.plugins.map((plugin) => ({
              type: "local" as const,
              path: plugin.path,
              skipMcpDiscovery: true,
            })),
          }
        : {}),
      allowedTools: [
        ...ALLOWED_TOOLS.filter(
          (name) => !(shellToolsDisabled && SHELL_EXECUTION_TOOLS.has(name)),
        ),
        ...(workspaceServer
          ? extraTools.map((def) => `mcp__workspace__${def.name}`)
          : []),
        // Server-wide allow per external connection ("mcp__<name>" covers
        // every tool the server exposes) — unless the host set a policy
        // for it, in which case each tool comes through canUseTool.
        ...Object.keys(externalServers)
          .filter((name) => !this.currentPolicies()?.[name])
          .map((name) => `mcp__${name}`),
      ],
      // Removing (not merely denying) the built-in shell tools takes them
      // out of the model's context — otherwise the CLI's own system prompt
      // keeps steering the model toward a Bash it can see but never use.
      ...(shellToolsDisabled
        ? { disallowedTools: [...SHELL_EXECUTION_TOOLS] }
        : {}),
      // AskUserQuestion is the CLI's native ask_user: the tool's own
      // permission check always routes through here, and the permission
      // result's updatedInput is how the answers reach it (the tool reads
      // `answers`/`response` from its input and returns them). Park the
      // promise; pumpTurn turns the park into a question turn and the
      // user's next message resolves it. Everything else outside the
      // allowlist stays denied.
      canUseTool: async (toolName, input, options) => {
        if (toolName === "AskUserQuestion") {
          return await new Promise<PermissionResult>((resolve) => {
            live.ask = { input, resolve };
            live.raiseAsk();
          });
        }
        const policed = await this.policedMcpDecision(
          toolName,
          input,
          toolContext?.sessionId,
        );
        if (policed) return policed;
        return denyUnlistedTools(toolName, input, options);
      },
      hooks: backgroundTaskHooks((event) => live.hookEvents.push(event)),
      // Recognize everything real Claude Code recognizes: the repo's
      // CLAUDE.md / .claude (skills, agents, commands, settings) plus the
      // agent's own home ("user" resolves inside this agent's private
      // CLAUDE_CONFIG_DIR, so credentials/config stay isolated per agent).
      // Imported dev repos must feel identical to the CLI.
      settingSources: ["user", "project", "local"],
    };
  }
}

/** Host-neutral MCP configs → the SDK's native `mcpServers` entries. */
function mapMcpServers(
  servers: Record<string, AgentMcpServerConfig>,
): Record<string, McpServerConfig> {
  const mapped: Record<string, McpServerConfig> = {};
  for (const [name, config] of Object.entries(servers)) {
    if (config.transport === "stdio") {
      mapped[name] = {
        type: "stdio",
        command: config.command,
        ...(config.args ? { args: config.args } : {}),
        ...(config.env ? { env: config.env } : {}),
      };
    } else {
      mapped[name] = {
        type: config.transport === "sse" ? "sse" : "http",
        url: config.url,
        ...(config.headers ? { headers: config.headers } : {}),
      };
    }
  }
  return mapped;
}

/**
 * Background-process interception. The CLI's own background machinery is
 * kept — Bash `run_in_background` and TaskOutput/TaskStop behave exactly
 * as they do in stock Claude Code — but PostToolUse hooks watch the
 * structured tool responses so the host learns the moment a background
 * task starts (the response's `backgroundTaskId`) or is stopped.
 */
function backgroundTaskHooks(
  emit: (event: AgentEvent) => void,
): Options["hooks"] {
  const onBashDone: HookCallback = async (input) => {
    const data = input as {
      tool_input?: { command?: string; run_in_background?: boolean };
      tool_response?: { backgroundTaskId?: string; timedOutAfterMs?: number };
    };
    const backgroundId = data.tool_response?.backgroundTaskId;
    if (backgroundId) {
      emit({
        type: "background",
        status: "started",
        backgroundId,
        content: data.tool_input?.command ?? "",
      });
    }
    return {};
  };
  const onTaskStop: HookCallback = async (input) => {
    const data = input as {
      tool_input?: { task_id?: string; shell_id?: string };
    };
    const backgroundId = data.tool_input?.task_id ?? data.tool_input?.shell_id;
    if (backgroundId) {
      emit({ type: "background", status: "ended", backgroundId });
    }
    return {};
  };
  // External MCP tool results: the assistant block only carries the CALL;
  // the result payload (what an MCP Apps view renders) arrives here.
  const onMcpToolDone: HookCallback = async (input) => {
    const data = input as {
      tool_name?: string;
      tool_use_id?: string;
      tool_input?: Record<string, unknown>;
      tool_response?: unknown;
    };
    const name = data.tool_name?.match(/^mcp__(.+?)__(.+)$/);
    if (!name || name[1] === "workspace" || !data.tool_use_id) return {};
    emit({
      type: "tool_call",
      toolName: `${name[1]}/${name[2]}`,
      toolInput: data.tool_input ?? {},
      toolUseId: data.tool_use_id,
      toolResult: extractMcpToolResult(data.tool_response),
    });
    return {};
  };
  return {
    PostToolUse: [
      { matcher: "Bash", hooks: [onBashDone] },
      { matcher: TASK_STOP_TOOLS.join("|"), hooks: [onTaskStop] },
      { matcher: "^mcp__", hooks: [onMcpToolDone] },
    ],
  };
}

/**
 * Structured content when the server sent it, else the flattened text —
 * the SDK's tool_response for MCP tools mirrors the MCP result shape.
 */
function extractMcpToolResult(response: unknown): unknown {
  if (!response || typeof response !== "object") return response ?? null;
  const record = response as {
    structuredContent?: unknown;
    content?: Array<{ type?: string; text?: string }>;
  };
  if (record.structuredContent !== undefined) return record.structuredContent;
  if (Array.isArray(record.content)) {
    const text = record.content
      .filter((block) => typeof block.text === "string")
      .map((block) => block.text)
      .join("\n");
    if (text) return text;
  }
  return record;
}

/** Minimal structural view of an Anthropic API content block. */
interface ContentBlockLike {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
}

function mapMessage(
  message: SDKMessage,
  openSubagents: Set<string>,
): AgentEvent[] {
  switch (message.type) {
    case "assistant": {
      const blocks =
        (message.message as { content?: ContentBlockLike[] }).content ?? [];
      const parentToolUseId =
        (message as { parent_tool_use_id?: string | null })
          .parent_tool_use_id ?? undefined;
      const events: AgentEvent[] = [];
      for (const block of blocks) {
        // Text inside a subagent is the subagent's own conversation, not
        // this chat's transcript — activity (tool use) is what surfaces.
        if (parentToolUseId && block.type === "text") continue;
        if (
          !parentToolUseId &&
          block.type === "tool_use" &&
          SUBAGENT_TOOLS.has(block.name ?? "") &&
          block.id
        ) {
          openSubagents.add(block.id);
          const input = block.input ?? {};
          events.push({
            type: "subagent",
            status: "started",
            subagentId: block.id,
            ...(typeof input.subagent_type === "string"
              ? { subagentType: input.subagent_type }
              : {}),
            content:
              typeof input.description === "string" ? input.description : "",
          });
          continue;
        }
        const mapped = mapContentBlock(block);
        if (mapped) {
          events.push(
            parentToolUseId
              ? { ...mapped, subagentId: parentToolUseId }
              : mapped,
          );
        }
      }
      return events;
    }
    case "user": {
      // A top-level tool_result answering a Task tool-use closes that
      // subagent. Nested results (parent_tool_use_id set) stay internal.
      if (
        (message as { parent_tool_use_id?: string | null }).parent_tool_use_id
      )
        return [];
      const blocks =
        (message.message as { content?: ContentBlockLike[] | string })
          .content ?? [];
      if (!Array.isArray(blocks)) return [];
      const events: AgentEvent[] = [];
      for (const block of blocks) {
        if (
          block.type === "tool_result" &&
          block.tool_use_id &&
          openSubagents.delete(block.tool_use_id)
        ) {
          events.push({
            type: "subagent",
            status: "ended",
            subagentId: block.tool_use_id,
          });
        }
      }
      return events;
    }
    case "result": {
      if (message.subtype === "success") {
        return [{ type: "done" }];
      }
      const detail = message.errors.filter(Boolean).join("\n");
      return [
        { type: "error", content: detail || message.subtype },
        { type: "done" },
      ];
    }
    default:
      // system/init and stream events are internal.
      return [];
  }
}

/**
 * Claude Code takes a text prompt; media rides along as temp files the CLI
 * reads with its own Read tool (which renders images natively). Files are
 * grouped per provider session and cleaned up with the OS temp dir.
 */
async function withAttachments(
  message: string,
  attachments: TurnOptions["attachments"],
  providerSessionId: string,
): Promise<string> {
  if (!attachments || attachments.length === 0) return message;
  // Text context goes straight into the prompt; only media needs temp files.
  const withText = `${message}${renderTextAttachments(attachments)}`;
  const media = attachments.filter(isMediaAttachment);
  if (media.length === 0) return withText;
  const dir = path.join(
    os.tmpdir(),
    "catamorphic-attachments",
    providerSessionId,
  );
  await fs.mkdir(dir, { recursive: true });
  const lines: string[] = [];
  for (const attachment of media) {
    // Names come from the user's clipboard/files — keep them readable but
    // path-safe, and unique enough not to clobber a same-named sibling.
    const safeName = `${crypto.randomUUID().slice(0, 8)}-${attachment.name.replace(/[^\w.-]+/g, "_")}`;
    const filePath = path.join(dir, safeName);
    await fs.writeFile(filePath, Buffer.from(attachment.dataBase64, "base64"));
    lines.push(`- ${filePath} (${attachment.mediaType})`);
  }
  return `${withText}\n\n[The user attached ${media.length === 1 ? "a file" : "files"} with this message — use the Read tool to view:\n${lines.join("\n")}]`;
}

/**
 * The SDK's AskUserQuestion input → the host-neutral question shape the
 * `question` AgentEvent carries (mirrors the ai-sdk harness's parsing, so
 * both harnesses feed the same question panel).
 */
function parseAskUserQuestions(input: unknown): AgentQuestion[] {
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

/**
 * The user's answer message → the parked call's `updatedInput`. The CLI's
 * AskUserQuestion tool reads `answers` (question text → answer string;
 * multi-select comma-separated) and `response` (freeform) from its input
 * and returns them to the model. The desktop question panel formats
 * multi-question answers as "<question>\n→ <answer>" blocks separated by
 * blank lines and sends a single question's answer bare; anything that
 * doesn't parse (a typed reply, a dismissal note) rides as freeform
 * `response` so the user's words always reach the model.
 */
function askUserAnswerInput(
  input: Record<string, unknown>,
  message: string,
): Record<string, unknown> {
  const questions = Array.isArray(input.questions) ? input.questions : [];
  const texts = questions.flatMap((entry) => {
    const question = asRecord(entry)?.question;
    return typeof question === "string" ? [question] : [];
  });
  const answers: Record<string, string> = {};
  for (const text of texts) {
    const marker = `${text}\n→ `;
    const index = message.indexOf(marker);
    if (index === -1) continue;
    const start = index + marker.length;
    const end = message.indexOf("\n\n", start);
    answers[text] = (
      end === -1 ? message.slice(start) : message.slice(start, end)
    ).trim();
  }
  const first = texts[0];
  if (Object.keys(answers).length === 0 && texts.length === 1 && first) {
    answers[first] = message.trim();
  }
  const unmatched = Object.keys(answers).length < texts.length;
  return {
    ...input,
    answers,
    ...(unmatched ? { response: message.trim() } : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/** MCP tool results are text; non-string tool returns ship as JSON. */
function stringifyToolResult(result: unknown): string {
  if (typeof result === "string") return result;
  if (result === undefined) return "ok";
  return JSON.stringify(result, null, 2);
}

function mapContentBlock(block: ContentBlockLike): AgentEvent | null {
  switch (block.type) {
    case "text":
      if (!block.text) return null;
      return { type: "text", content: block.text };
    case "tool_use": {
      // Workspace MCP tools surface under their plain names — the
      // transport prefix is harness plumbing, not activity the user
      // should read.
      const name = (block.name ?? "").replace(/^mcp__workspace__/, "");
      const input = block.input ?? {};
      // The question panel is this call's surface (the canUseTool park
      // turns it into a `question` event); a tool_call step row for it
      // would be noise — matching the ai-sdk harness's ask_user.
      if (name === "AskUserQuestion") return null;
      if (name === "Bash") {
        return { type: "command", content: String(input.command ?? "") };
      }
      if (FILE_EDIT_TOOLS.has(name)) {
        const filePath = input.file_path ?? input.notebook_path;
        return {
          type: "file_edit",
          filePath: typeof filePath === "string" ? filePath : undefined,
          content: name.toLowerCase(),
        };
      }
      // External MCP tools read as "server/tool" (matching the other
      // harnesses) and keep their tool-use id so the result-carrying
      // hook event below correlates.
      const external = name.match(/^mcp__(.+?)__(.+)$/);
      if (external) {
        return {
          type: "tool_call",
          toolName: `${external[1]}/${external[2]}`,
          toolInput: input,
          ...(block.id ? { toolUseId: block.id } : {}),
        };
      }
      return { type: "tool_call", toolName: name, toolInput: input };
    }
    default:
      return null;
  }
}
