import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { JsonObject, JsonValue } from "@catamorphic/agent-protocol";
import type { HarnessEvent } from "@catamorphic/agent-protocol/runner";

/**
 * A recorded Claude Code transcript (ADR 0197, "Tests replay real
 * transcripts"): what the adapter sent the Agent SDK and everything the SDK
 * did back, in the order the adapter observed it. Replaying it replaces
 * only the SDK transport; the adapter, runner and host run for real.
 */
export interface ClaudeReplayTranscript {
  provider: "claude-code";
  /** The pinned `@anthropic-ai/claude-agent-sdk` it was recorded with. */
  sdkVersion: string;
  /** The CLI's own version, from its init message. */
  cliVersion: string | null;
  scenario: string;
  /** `recorded` from the real CLI; `authored` by hand from the SDK's types. */
  source: "recorded" | "authored";
  attempts: ClaudeReplayAttempt[];
}

/** One query: one attempt of a turn. */
export interface ClaudeReplayAttempt {
  outbound: ClaudeOutbound;
  /** SDK messages and the adapter's callbacks, interleaved in order. */
  messages: ReplayEntry[];
  /** The harness events the live run emitted, for golden comparison. */
  events?: HarnessEvent[];
}

/**
 * Something the SDK did besides yielding a message, at the point it did
 * it. Replay performs each one against the adapter's own callbacks.
 */
export type ReplayCallback =
  /** The CLI read the next input message (the first prompt or a steer). */
  | { type: "replay.input"; uuid: string | null; text: string }
  /** The adapter called `interrupt()`; replay waits for it. */
  | { type: "replay.interrupt" }
  | {
      type: "replay.can_use_tool";
      toolName: string;
      input: JsonObject;
      toolUseID: string;
      /** What the adapter decided when recorded. */
      result: JsonObject | null;
    }
  | {
      type: "replay.elicitation";
      request: JsonObject;
      requestId: string;
      result: JsonObject | null;
    }
  | {
      type: "replay.hook";
      event: string;
      toolUseID: string | null;
      input: JsonObject;
    }
  | {
      type: "replay.store";
      op: "append" | "load" | "list_subkeys";
      sessionId: string;
      subpath: string | null;
      /** Appended entries, or what a load returned when recorded. */
      entries: JsonValue[] | null;
    }
  | {
      type: "replay.mcp_call";
      server: string;
      tool: string;
      arguments: JsonObject;
      /** What the in-process server answered when recorded. */
      result: JsonValue | null;
    };

export type ReplayEntry = SDKMessage | ReplayCallback;

export function isReplayCallback(entry: ReplayEntry): entry is ReplayCallback {
  return entry.type.startsWith("replay.");
}

/**
 * The essentials of what the adapter asked the SDK for: enough to catch a
 * change in how an attempt maps to the CLI, without host paths or values
 * that differ between runs.
 */
export interface ClaudeOutbound {
  prompt: string;
  cwd: string | null;
  thread: {
    sessionId: string | null;
    resume: string | null;
    forkSession: boolean;
    resumeSessionAt: string | null;
  };
  model: string | null;
  effort: string | null;
  permissionMode: string | null;
  systemPromptAppend: string | null;
  allowedTools: string[];
  disallowedTools: string[];
  /** Server name to transport type. */
  mcpServers: Record<string, string>;
  /** The variables that carry model access and harness switches. */
  env: Record<string, string>;
  apiKeyHelper: string | null;
  includePartialMessages: boolean;
  sessionStore: boolean;
  hooks: string[];
}

const OUTBOUND_ENV = [
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CONFIG_DIR",
  "WORK_MODEL_KEY_FILE",
  "CLAUDE_CODE_API_KEY_HELPER_TTL_MS",
  "CLAUDE_CODE_DISABLE_AUTO_MEMORY",
  "CLAUDE_CODE_DISABLE_BACKGROUND_TASKS",
  "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
  "DISABLE_AUTOUPDATER",
  "IS_SANDBOX",
];

export function outboundOf(input: {
  options: Options;
  prompt: string;
}): ClaudeOutbound {
  const { options } = input;
  const env: Record<string, string> = {};
  for (const key of OUTBOUND_ENV) {
    const value = options.env?.[key];
    if (typeof value === "string") env[key] = value;
  }
  const settings = options.settings;
  const systemPrompt = options.systemPrompt;
  return {
    prompt: input.prompt,
    cwd: options.cwd ?? null,
    thread: {
      sessionId: options.sessionId ?? null,
      resume: options.resume ?? null,
      forkSession: options.forkSession === true,
      resumeSessionAt: options.resumeSessionAt ?? null,
    },
    model: options.model ?? null,
    effort: typeof options.effort === "string" ? options.effort : null,
    permissionMode: options.permissionMode ?? null,
    systemPromptAppend:
      systemPrompt &&
      typeof systemPrompt === "object" &&
      "append" in systemPrompt
        ? (systemPrompt.append ?? null)
        : null,
    allowedTools: [...(options.allowedTools ?? [])].sort(),
    disallowedTools: [...(options.disallowedTools ?? [])].sort(),
    mcpServers: Object.fromEntries(
      Object.entries(options.mcpServers ?? {}).map(([name, config]) => [
        name,
        config.type ?? "stdio",
      ]),
    ),
    env,
    apiKeyHelper:
      settings && typeof settings === "object"
        ? (settings.apiKeyHelper ?? null)
        : null,
    includePartialMessages: options.includePartialMessages === true,
    sessionStore: options.sessionStore !== undefined,
    hooks: Object.keys(options.hooks ?? {}).sort(),
  };
}

/**
 * Host paths and run-specific values as tokens (`{{cwd}}`), so a fixture
 * names no machine and a replay puts its own directories back.
 */
export interface ReplayTokens {
  [token: string]: string;
}

/** Each value's spellings: as given, and as the CLI's project key spells a path. */
function spellings(value: string): string[] {
  return [value, value.replace(/[^a-zA-Z0-9]/g, "-")];
}

export function tokenize(text: string, tokens: ReplayTokens): string {
  // Longest values first, so a directory inside another keeps its own token.
  const pairs = Object.entries(tokens)
    .flatMap(([token, value]) =>
      spellings(value).map((spelling, index) => ({
        token: index === 0 ? `{{${token}}}` : `{{${token}-key}}`,
        spelling,
      })),
    )
    .filter((pair) => pair.spelling.length > 0)
    .sort((a, b) => b.spelling.length - a.spelling.length);
  let result = text;
  for (const pair of pairs)
    result = result.split(pair.spelling).join(pair.token);
  return result;
}

export function detokenize(text: string, tokens: ReplayTokens): string {
  let result = text;
  for (const [token, value] of Object.entries(tokens)) {
    const [plain = value, key = value] = spellings(value);
    result = result
      .split(`{{${token}-key}}`)
      .join(key)
      .split(`{{${token}}}`)
      .join(plain);
  }
  return result;
}
