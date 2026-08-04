import {
  type CanUseTool,
  type Options,
  query,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentEffort,
  AgentEvent,
  CodingAgentProvider,
  ProviderSession,
  StartSessionOpts,
  TurnOptions,
} from "@catamorphic/sandbox";
import { buildPluginsPreamble, stagePluginDocs } from "@catamorphic/sandbox";

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
  "Task",
];

/** Tool names whose invocations are surfaced as `file_edit` events. */
const FILE_EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

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

    // The SDK only reveals its session id once a query starts (the
    // system/init message carries it), so run a minimal kickoff turn and
    // capture the id from the stream.
    const kickoff = query({
      prompt: "Reply with exactly: OK.",
      options: {
        ...this.buildOptions(opts.workingDirectory, systemPrompt),
        maxTurns: 1,
      },
    });

    let sessionId: string | null = null;
    for await (const message of kickoff) {
      if (
        sessionId === null &&
        "session_id" in message &&
        typeof message.session_id === "string"
      ) {
        sessionId = message.session_id;
      }
    }
    if (!sessionId) {
      throw new Error("Claude Code did not report a session id on startup");
    }

    this.sessions.set(sessionId, {
      systemPrompt,
      workingDirectory: opts.workingDirectory,
    });

    return {
      providerSessionId: sessionId,
      sandboxId: opts.sandboxId,
      workingDirectory: opts.workingDirectory,
    };
  }

  async resumeSession(providerSessionId: string): Promise<ProviderSession> {
    const existing = this.sessions.get(providerSessionId);
    // Resume needs no upfront call: the CLI replays its persisted transcript
    // when the next query passes `resume`. Sessions from before a host
    // restart therefore work too — they just have no in-memory state.
    return {
      providerSessionId,
      sandboxId: "",
      workingDirectory: existing?.workingDirectory ?? "",
    };
  }

  async *sendMessage(
    session: ProviderSession,
    message: string,
    opts?: TurnOptions,
  ): AsyncIterable<AgentEvent> {
    const state = this.sessions.get(session.providerSessionId);
    const cwd =
      session.workingDirectory || state?.workingDirectory || undefined;

    const abort = new AbortController();
    this.activeAborts.set(session.providerSessionId, abort);

    let done = false;
    try {
      const turn = query({
        prompt: message,
        options: {
          ...this.buildOptions(cwd, state?.systemPrompt, opts),
          resume: session.providerSessionId,
          abortController: abort,
        },
      });

      for await (const sdkMessage of turn) {
        for (const event of mapMessage(sdkMessage)) {
          if (event.type === "done") done = true;
          yield event;
        }
      }
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
      this.activeAborts.delete(session.providerSessionId);
    }
  }

  async dispose(session: ProviderSession): Promise<void> {
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
    turn?: TurnOptions,
  ): Options {
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
      allowedTools: [...ALLOWED_TOOLS],
      canUseTool: denyUnlistedTools,
      // Ignore the user's own ~/.claude and project settings files — the
      // harness is self-contained.
      settingSources: [],
    };
  }
}

/** Minimal structural view of an Anthropic API content block. */
interface ContentBlockLike {
  type: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
}

function mapMessage(message: SDKMessage): AgentEvent[] {
  switch (message.type) {
    case "assistant": {
      const blocks =
        (message.message as { content?: ContentBlockLike[] }).content ?? [];
      const events: AgentEvent[] = [];
      for (const block of blocks) {
        const mapped = mapContentBlock(block);
        if (mapped) events.push(mapped);
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
      // system/init, user (tool results), and stream events are internal.
      return [];
  }
}

function mapContentBlock(block: ContentBlockLike): AgentEvent | null {
  switch (block.type) {
    case "text":
      if (!block.text) return null;
      return { type: "text", content: block.text };
    case "tool_use": {
      const name = block.name ?? "";
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
