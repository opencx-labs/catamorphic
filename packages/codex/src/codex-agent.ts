import type {
  AgentEffort,
  AgentEvent,
  CodingAgentProvider,
  ProviderSession,
  StartSessionOpts,
  TurnOptions,
} from "@catamorphic/sandbox";
import { buildPluginsPreamble, stagePluginDocs } from "@catamorphic/sandbox";
import {
  Codex,
  type ThreadEvent,
  type ThreadItem,
  type ThreadOptions,
} from "@openai/codex-sdk";

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
  private readonly client: Codex;
  private readonly opts: CodexAgentOpts;

  constructor(opts: CodexAgentOpts = {}) {
    this.opts = opts;
    this.client = new Codex({
      apiKey: opts.apiKey,
      baseUrl: opts.baseUrl,
      codexPathOverride: opts.codexPathOverride,
      // The SDK stops inheriting process.env once env is provided — merge
      // ourselves so PATH and friends survive alongside the overrides.
      ...(opts.env ? { env: mergedEnv(opts.env) } : {}),
    });
  }

  async startSession(opts: StartSessionOpts): Promise<ProviderSession> {
    await stagePluginDocs(opts.workingDirectory, opts.attachedPlugins);
    const preamble = buildPluginsPreamble(opts.attachedPlugins);
    const instructions = [preamble, opts.systemPrompt ?? ""]
      .filter(Boolean)
      .join("\n\n");

    // The CLI only reveals its thread id once a turn starts, so anchor the
    // session with a kickoff turn that delivers the session instructions.
    const thread = this.client.startThread(
      this.threadOptions(opts.workingDirectory),
    );
    const kickoff = instructions
      ? `${instructions}\n\nThese are your standing instructions for this session. Reply with exactly: OK.`
      : "Reply with exactly: OK.";
    const { events } = await thread.runStreamed(kickoff);
    let threadId: string | null = null;
    // Drain the stream fully — breaking out early tears down the CLI process
    // mid-turn and can leave the persisted thread unresumable.
    for await (const event of events) {
      if (event.type === "thread.started") threadId = event.thread_id;
    }
    if (!threadId) {
      throw new Error("Codex did not report a thread id for the new session");
    }

    return {
      providerSessionId: threadId,
      sandboxId: opts.sandboxId,
      workingDirectory: opts.workingDirectory,
    };
  }

  async resumeSession(providerSessionId: string): Promise<ProviderSession> {
    // Threads persist under $CODEX_HOME/sessions; nothing to warm up.
    return {
      providerSessionId,
      sandboxId: "",
      workingDirectory: "",
    };
  }

  async *sendMessage(
    session: ProviderSession,
    message: string,
    opts?: TurnOptions,
  ): AsyncIterable<AgentEvent> {
    // Each turn resumes the persisted thread with fresh options, so per-turn
    // model/effort overrides take effect without any in-memory thread state.
    const thread = this.client.resumeThread(
      session.providerSessionId,
      this.threadOptions(session.workingDirectory, opts),
    );

    let stream: AsyncIterable<ThreadEvent>;
    try {
      stream = (await thread.runStreamed(message)).events;
    } catch (error) {
      yield { type: "error", content: describeError(error) };
      yield { type: "done" };
      return;
    }

    try {
      for await (const event of stream) {
        yield* mapEvent(event);
      }
    } catch (error) {
      yield { type: "error", content: describeError(error) };
      yield { type: "done" };
    }
  }

  async dispose(_session: ProviderSession): Promise<void> {
    // Threads live on disk under $CODEX_HOME; nothing to release in-process.
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
      approvalPolicy: "never",
      networkAccessEnabled: this.opts.networkAccessEnabled ?? true,
      ...(model ? { model } : {}),
      ...(effort ? { modelReasoningEffort: effort } : {}),
    };
  }
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

function mapEvent(event: ThreadEvent): AgentEvent[] {
  switch (event.type) {
    case "item.completed":
      return mapItemEvent(event.item);
    case "turn.completed":
      return [{ type: "done" }];
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
    case "command_execution":
      return [
        {
          type: "command",
          content: `${item.command}\n${item.aggregated_output}`,
        },
      ];
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
    case "mcp_tool_call":
      return [
        {
          type: "tool_call",
          toolName: `${item.server}/${item.tool}`,
          toolInput: item.arguments,
        },
      ];
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
