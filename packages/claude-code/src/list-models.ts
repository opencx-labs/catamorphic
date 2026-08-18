import { query } from "@anthropic-ai/claude-agent-sdk";

export interface ClaudeCodeModel {
  id: string;
  name: string;
  description?: string;
  /** Versioned model id an alias resolves to (e.g. "sonnet" → "claude-sonnet-5"). */
  resolvedId?: string;
}

/**
 * The models the Claude Code CLI would offer this environment, straight
 * from the CLI itself (`supportedModels` on a live query) — account-aware
 * and never hardcoded. Opens a streaming-input query that sends nothing,
 * asks for the catalog over the control channel, then aborts.
 */
export async function listClaudeCodeModels(opts?: {
  /** Merged over process.env (e.g. CLAUDE_CONFIG_DIR, ANTHROPIC_API_KEY). */
  env?: Record<string, string>;
}): Promise<ClaudeCodeModel[]> {
  const abort = new AbortController();
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Yields nothing; keeps the CLI's stdin open until we're done asking.
  // biome-ignore lint/correctness/useYield: an empty async iterable is the point
  async function* silence() {
    await gate;
  }

  const live = query({
    prompt: silence(),
    options: {
      abortController: abort,
      maxTurns: 1,
      env: { ...processEnv(), ...opts?.env },
    },
  });
  try {
    const models = await live.supportedModels();
    return models.map((model) => ({
      id: model.value,
      name: model.displayName,
      description: model.description,
      resolvedId: model.resolvedModel,
    }));
  } finally {
    release();
    abort.abort();
  }
}

function processEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  return env;
}
