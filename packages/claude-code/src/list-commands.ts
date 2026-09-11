import {
  type Options,
  query,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

/**
 * A slash command the Claude Code CLI would accept in this project:
 * built-ins (/compact, /review, …), `.claude/commands` files, plugin and
 * skill commands — whatever the CLI itself reports.
 */
export interface ClaudeSlashCommand {
  name: string;
  description: string;
  /** e.g. "<file>" — empty when the command takes no arguments. */
  argumentHint: string;
}

/**
 * Discover the CLI's slash commands WITHOUT running a conversation: the
 * prompt is an async iterable that never yields, so the subprocess
 * completes its local initialization (which carries the command list) but
 * never issues an API request; we read the list and abort. The same trick
 * t3-code uses for its capabilities probe.
 */
export async function listClaudeSlashCommands(opts: {
  workingDirectory: string;
  /** Extra env for the spawned CLI (e.g. CLAUDE_CONFIG_DIR). */
  env?: Record<string, string>;
  /** Host-provided CLI path, including an on-demand desktop component. */
  pathToClaudeCodeExecutable?: string;
  /** Same installed plugins used by the executing session. */
  plugins?: Options["plugins"];
  /** Give up after this long (default 15s) — a probe is never worth a wait. */
  timeoutMs?: number;
}): Promise<ClaudeSlashCommand[]> {
  const abort = new AbortController();
  const never = (async function* (): AsyncGenerator<SDKUserMessage> {
    await new Promise<void>((resolve) => {
      if (abort.signal.aborted) return resolve();
      abort.signal.addEventListener("abort", () => resolve(), { once: true });
    });
  })();
  const turn = query({
    prompt: never,
    options: {
      cwd: opts.workingDirectory,
      abortController: abort,
      env: { ...process.env, ...opts.env },
      pathToClaudeCodeExecutable: opts.pathToClaudeCodeExecutable,
      settingSources: ["user", "project", "local"],
      plugins: opts.plugins,
      // Discovery must not execute hooks, connect MCP servers, or ask a model.
      settings: { disableAllHooks: true },
      strictMcpConfig: true,
      mcpServers: {},
      tools: [],
      permissionMode: "default",
      persistSession: false,
    },
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      reject(new Error("Command discovery timed out. Try again."));
      abort.abort();
      turn.close();
    }, opts.timeoutMs ?? 15_000);
  });
  try {
    const commands = await Promise.race([turn.supportedCommands(), deadline]);
    return commands.map((command) => ({
      name: command.name,
      description: command.description,
      argumentHint: command.argumentHint,
    }));
  } finally {
    clearTimeout(timeout);
    abort.abort();
    turn.close();
  }
}
