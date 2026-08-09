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
  query,
  type SDKMessage,
  tool as sdkTool,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentEffort,
  AgentEvent,
  AgentMcpServerConfig,
  AgentPluginConfig,
  CodingAgentProvider,
  ExtraTool,
  ExtraToolContext,
  ProviderSession,
  StartSessionOpts,
  TurnOptions,
} from "@catamorphic/sandbox";
import { buildPluginsPreamble, stagePluginDocs } from "@catamorphic/sandbox";
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
   * Remove the built-in Bash tool from the allowlist. Claude Code's own
   * shell runs inside the CLI process where the host can't see or manage
   * it; hosts that provide terminal tools via {@link extraTools} disable
   * Bash so every command runs through terminals the host fully
   * intercepts (and the user can watch and take over). Background-task
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
   * Installed connector plugins, loaded natively (commands, agents,
   * skills, hooks). MCP discovery inside the plugin is disabled — the
   * host lifts a plugin's MCP servers into {@link mcpServers} so every
   * harness gets them, not just this one.
   */
  plugins?: AgentPluginConfig[];
}

/**
 * Tools the harness lets Claude Code use without prompting. Everything else
 * is routed through {@link denyUnlistedTools} and rejected — the desktop
 * product runs unattended, so there is no one to answer a permission prompt.
 */
const ALLOWED_TOOLS = [
  "Bash",
  "Read",
  "Glob",
  "Grep",
  "Edit",
  "Write",
  "WebSearch",
  "WebFetch",
  "TodoWrite",
  "NotebookEdit",
  // The subagent tool — "Task" in older CLIs, renamed "Agent" in 2.1.x.
  "Task",
  "Agent",
  // Background-task management: follow output / stop. Newer CLIs use
  // TaskOutput/TaskStop; BashOutput/KillShell are the legacy names.
  "TaskOutput",
  "TaskStop",
  "BashOutput",
  "KillShell",
];

/** Tool names whose invocations are surfaced as `file_edit` events. */
const FILE_EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** Both generations of the subagent tool's name. */
const SUBAGENT_TOOLS = new Set(["Task", "Agent"]);

/** Both generations of the stop-background-task tool's name. */
const TASK_STOP_TOOLS = ["TaskStop", "KillShell"];

/**
 * Permission fallback for tools outside {@link ALLOWED_TOOLS}: deny with a
 * reason the model can read, instead of hanging on a prompt nobody will see.
 */
const denyUnlistedTools: CanUseTool = async () => ({
  behavior: "deny",
  message: "This tool is not available in the Catamorphic desktop harness.",
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
    const state = this.sessions.get(providerSessionId);
    const cwd =
      session.workingDirectory || state?.workingDirectory || undefined;

    const abort = new AbortController();
    this.activeAborts.set(providerSessionId, abort);

    let done = false;
    // Background-process lifecycle arrives through SDK hooks (the CLI's
    // structured tool responses carry the task ids); hooks fire between
    // stream messages, so events queue here and drain with the stream.
    const hookEvents: AgentEvent[] = [];
    // Subagents this turn spawned, keyed by their Task tool-use id — the
    // same id nested activity carries as parent_tool_use_id, and the id
    // the closing tool_result answers.
    const openSubagents = new Set<string>();
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
            (event) => hookEvents.push(event),
          ),
          ...anchor,
          abortController: abort,
        },
      });

      for await (const sdkMessage of turn) {
        // The init message means the CLI booted and owns the transcript;
        // from here on this session must be resumed, never re-created.
        if (state && sdkMessage.type === "system") {
          state.transcriptExists = true;
        }
        yield* hookEvents.splice(0);
        for (const event of mapMessage(sdkMessage, openSubagents)) {
          if (event.type === "done") done = true;
          yield event;
        }
      }
      yield* hookEvents.splice(0);
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
    this.sessions.delete(session.providerSessionId);
  }

  /**
   * Options shared by every query for a session: host cwd, merged env,
   * executable overrides, unattended permissions, and the model/effort
   * defaults with per-turn overrides applied.
   */
  private buildOptions(
    cwd: string | undefined,
    systemPrompt: string | undefined,
    toolContext: ExtraToolContext | undefined,
    turn: TurnOptions | undefined,
    emitHookEvent: (event: AgentEvent) => void,
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

    const externalServers = mapMcpServers(this.opts.mcpServers ?? {});

    return {
      cwd,
      systemPrompt,
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
          (name) => !(this.opts.disableBash && name === "Bash"),
        ),
        ...(workspaceServer
          ? extraTools.map((def) => `mcp__workspace__${def.name}`)
          : []),
        // Server-wide allow per external connection ("mcp__<name>" covers
        // every tool the server exposes).
        ...Object.keys(externalServers).map((name) => `mcp__${name}`),
      ],
      canUseTool: denyUnlistedTools,
      hooks: backgroundTaskHooks(emitHookEvent),
      // Ignore the user's own ~/.claude and project settings files — the
      // harness is self-contained.
      settingSources: [],
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
  return {
    PostToolUse: [
      { matcher: "Bash", hooks: [onBashDone] },
      { matcher: TASK_STOP_TOOLS.join("|"), hooks: [onTaskStop] },
    ],
  };
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
  const dir = path.join(
    os.tmpdir(),
    "catamorphic-attachments",
    providerSessionId,
  );
  await fs.mkdir(dir, { recursive: true });
  const lines: string[] = [];
  for (const attachment of attachments) {
    // Names come from the user's clipboard/files — keep them readable but
    // path-safe, and unique enough not to clobber a same-named sibling.
    const safeName = `${crypto.randomUUID().slice(0, 8)}-${attachment.name.replace(/[^\w.-]+/g, "_")}`;
    const filePath = path.join(dir, safeName);
    await fs.writeFile(filePath, Buffer.from(attachment.dataBase64, "base64"));
    lines.push(`- ${filePath} (${attachment.mediaType})`);
  }
  return `${message}\n\n[The user attached ${attachments.length === 1 ? "a file" : "files"} with this message — use the Read tool to view:\n${lines.join("\n")}]`;
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
      return { type: "tool_call", toolName: name, toolInput: input };
    }
    default:
      return null;
  }
}
