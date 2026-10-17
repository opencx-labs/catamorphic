import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { hostProcessEnv } from "./options.js";

export interface ClaudeCodeModel {
  id: string;
  name: string;
  description?: string;
  /** Versioned model id an alias resolves to (e.g. "sonnet" → "claude-sonnet-5"). */
  resolvedId?: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: ("low" | "medium" | "high" | "xhigh" | "max")[];
}

/**
 * The models the Claude Code CLI would offer this environment, straight
 * from the CLI itself (`supportedModels` on a live query) — account-aware
 * and never hardcoded. Opens a streaming-input query that sends nothing,
 * asks for the catalog over the control channel, then aborts.
 */
export async function listClaudeCodeModels(opts?: {
  /** Over the host's environment (see hostProcessEnv), e.g. CLAUDE_CONFIG_DIR. */
  env?: Record<string, string>;
  /** Host-provided CLI path, including an on-demand desktop component. */
  pathToClaudeCodeExecutable?: string;
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
      env: { ...hostProcessEnv({ env: opts?.env }), ...opts?.env },
      pathToClaudeCodeExecutable: opts?.pathToClaudeCodeExecutable,
    },
  });
  try {
    const models = await live.supportedModels();
    return models.map((model) => ({
      id: model.value,
      name: model.displayName,
      description: model.description,
      resolvedId: model.resolvedModel,
      supportsEffort: model.supportsEffort,
      supportedEffortLevels: model.supportedEffortLevels,
    }));
  } finally {
    release();
    abort.abort();
  }
}

/** The model a Claude Code session in this folder runs when none is pinned. */
export interface ClaudeCodeDefaultModel {
  /** Wire id the CLI will send (e.g. "claude-sonnet-5", "claude-opus-5[1m]"). */
  id: string;
  /** Catalog display name for that id, when the catalog lists it. */
  name?: string;
}

/**
 * Ask the CLI which model it would run here, before any turn: the effective
 * merge of env (`ANTHROPIC_MODEL`), user, project and local settings, and
 * the account's own default — exactly what a session in `workingDirectory`
 * gets. Opens a streaming-input query that never yields (no API request),
 * reads the CLI's `get_settings` control answer, and closes. Returns null
 * when the CLI cannot say (an older CLI without `get_settings`): callers
 * then name the default honestly instead of guessing.
 */
export async function resolveClaudeCodeModel(opts: {
  workingDirectory: string;
  /** Over the host's environment (see hostProcessEnv), e.g. CLAUDE_CONFIG_DIR. */
  env?: Record<string, string>;
  /** Host-provided CLI path, including an on-demand desktop component. */
  pathToClaudeCodeExecutable?: string;
  /** Give up after this long (default 15s) — a probe is never worth a wait. */
  timeoutMs?: number;
}): Promise<ClaudeCodeDefaultModel | null> {
  const abort = new AbortController();
  const never = (async function* (): AsyncGenerator<SDKUserMessage> {
    await new Promise<void>((resolve) => {
      if (abort.signal.aborted) return resolve();
      abort.signal.addEventListener("abort", () => resolve(), { once: true });
    });
  })();
  const live = query({
    prompt: never,
    options: {
      cwd: opts.workingDirectory,
      abortController: abort,
      env: {
        ...hostProcessEnv({
          env: opts.env,
          workingDirectory: opts.workingDirectory,
        }),
        ...opts.env,
      },
      pathToClaudeCodeExecutable: opts.pathToClaudeCodeExecutable,
      // The same sources a session reads, so project and local settings
      // pinning a model count.
      settingSources: ["user", "project", "local"],
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
      reject(new Error("Model discovery timed out. Try again."));
      abort.abort();
      live.close();
    }, opts.timeoutMs ?? 15_000);
  });
  try {
    const id = await Promise.race([appliedModel(live), deadline]);
    if (!id) return null;
    const catalog = await Promise.race([live.supportedModels(), deadline]);
    // The "default" row names the account default, which settings may
    // override; only a concrete row is a faithful name for the id.
    const row = catalog.find(
      (model) =>
        model.value !== "default" &&
        (model.resolvedModel === id || model.value === id),
    );
    return { id, ...(row ? { name: row.displayName } : {}) };
  } finally {
    clearTimeout(timeout);
    abort.abort();
    // close() returns before the CLI exits; await the iterator cleanup so
    // callers can safely release the working directory.
    await live.return();
  }
}

/** One plan window of a Claude sign-in, as `/usage` shows it. */
export interface ClaudeCodeUsageWindow {
  /** Percent of the window used, 0-100. */
  utilization: number;
  /** When the window resets (ISO 8601). */
  resetsAt?: string;
}

/** A Claude Code sign-in and its plan usage, as the CLI reports them. */
export interface ClaudeCodeUsage {
  /** The CLI is signed in to a Claude account (not a key or a gateway). */
  signedIn: boolean;
  email?: string;
  /** The account's plan as the CLI names it ("Claude Max"). */
  plan?: string;
  fiveHour?: ClaudeCodeUsageWindow;
  sevenDay?: ClaudeCodeUsageWindow;
}

/**
 * Who the CLI is signed in as and the plan usage `/usage` shows, asked of
 * the CLI over its control channel (`get_usage`, which the SDK still marks
 * experimental). The CLI reads both with its own sign-in, so the host never
 * touches a credential. Opens a query that never sends a prompt (no model
 * request), asks, and closes.
 */
export async function readClaudeCodeUsage(opts: {
  /** Over the host's environment (see hostProcessEnv), e.g. CLAUDE_CONFIG_DIR. */
  env?: Record<string, string>;
  /** Host-provided CLI path, including an on-demand desktop component. */
  pathToClaudeCodeExecutable?: string;
  /** Give up after this long (default 15s). */
  timeoutMs?: number;
}): Promise<ClaudeCodeUsage> {
  const abort = new AbortController();
  const never = (async function* (): AsyncGenerator<SDKUserMessage> {
    await new Promise<void>((resolve) => {
      if (abort.signal.aborted) return resolve();
      abort.signal.addEventListener("abort", () => resolve(), { once: true });
    });
  })();
  const live = query({
    prompt: never,
    options: {
      abortController: abort,
      env: { ...hostProcessEnv({ env: opts.env }), ...opts.env },
      pathToClaudeCodeExecutable: opts.pathToClaudeCodeExecutable,
      // Asking must not execute hooks, connect MCP servers, or ask a model.
      settings: { disableAllHooks: true },
      strictMcpConfig: true,
      mcpServers: {},
      tools: [],
      persistSession: false,
    },
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      reject(new Error("Claude usage did not answer in time."));
      abort.abort();
      live.close();
    }, opts.timeoutMs ?? 15_000);
  });
  try {
    const account = await Promise.race([live.accountInfo(), deadline]);
    if (!account.email) return { signedIn: false };
    const usage = await Promise.race([
      live.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({
        skipBehaviors: true,
      }),
      deadline,
    ]);
    const window = (
      value: { utilization: number | null; resets_at: string | null } | null,
    ): ClaudeCodeUsageWindow | undefined =>
      typeof value?.utilization === "number"
        ? {
            utilization: value.utilization,
            ...(value.resets_at ? { resetsAt: value.resets_at } : {}),
          }
        : undefined;
    const fiveHour = window(usage.rate_limits?.five_hour ?? null);
    const sevenDay = window(usage.rate_limits?.seven_day ?? null);
    return {
      signedIn: true,
      email: account.email,
      ...(account.subscriptionType ? { plan: account.subscriptionType } : {}),
      ...(fiveHour ? { fiveHour } : {}),
      ...(sevenDay ? { sevenDay } : {}),
    };
  } finally {
    clearTimeout(timeout);
    abort.abort();
    await live.return();
  }
}

/**
 * `get_settings` is part of the CLI's control protocol ("the effective
 * merged settings", `applied.model` being the model the next request
 * sends). The SDK implements `Query.getSettings` without typing it yet, so
 * detect it and read the answer structurally.
 */
async function appliedModel(live: object): Promise<string | undefined> {
  if (!("getSettings" in live) || typeof live.getSettings !== "function")
    return undefined;
  const settings: unknown = await live.getSettings();
  if (!isRecord(settings) || !isRecord(settings.applied)) return undefined;
  const model = settings.applied.model;
  return typeof model === "string" && model ? model : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
