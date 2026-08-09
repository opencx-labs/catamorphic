import type { AgentEvent } from "../types.js";

/**
 * Lightweight description of a plugin package attached to a project. Passed
 * into {@link CodingAgentProvider.startSession} so the agent can (1) stage
 * the plugin's docs inside the working directory for filesystem discovery,
 * and (2) prepend an "attached packages" preamble to the system prompt.
 *
 * `files` is a map of paths relative to the plugin package root. Only docs
 * (README, `dist/index.d.ts`) are expected — not the full package contents.
 */
export interface AttachedPluginForAgent {
  packageName: string;
  displayName: string;
  description: string;
  files: Record<string, string>;
}

export interface StartSessionOpts {
  projectId: string;
  userId: string;
  sandboxId: string;
  workingDirectory: string;
  /**
   * The host-side chat session id this provider session anchors (not the
   * provider's own id). Lets host-supplied tools attribute the surfaces
   * they create — e.g. a browser tab opened by an agent attaches to the
   * chat that opened it.
   */
  sessionId: string;
  systemPrompt?: string;
  attachedPlugins?: AttachedPluginForAgent[];
  /**
   * Prior conversation turns to seed the new provider session with —
   * how a host resurrects a chat whose in-memory harness state is gone
   * (host restart, provider rebuild after a credential change). Harnesses
   * with their own durable transcripts (Claude Code) ignore it.
   */
  history?: Array<{ role: "user" | "assistant"; content: string }>;
}

export interface ProviderSession {
  /**
   * The harness's native session id, or null when the harness only learns
   * it once the first turn runs (Codex threads get their id from the CLI).
   * Such harnesses report the id with a "session" {@link AgentEvent} on the
   * first turn; the host persists it and passes it back on later turns. No
   * harness may burn a model turn just to learn its own id.
   */
  providerSessionId: string | null;
  /** Host-side chat session id (see {@link StartSessionOpts.sessionId}). */
  sessionId: string;
  /** Project the session belongs to; stable for the session's lifetime. */
  projectId: string;
  sandboxId: string;
  workingDirectory: string;
}

/**
 * Normalized reasoning-effort scale shared by every harness. Each provider
 * maps it onto its native knob (thinking budgets, reasoning effort levels);
 * providers that have no such knob ignore it.
 */
export type AgentEffort = "low" | "medium" | "high";

/**
 * A harness-neutral MCP server configuration — the shape profile-level
 * connections resolve to before each harness maps it onto its native
 * mechanism (Claude Code `mcpServers`, Codex `mcp_servers` config, the
 * built-in agent's own MCP client). Streamable HTTP is the preferred
 * transport; "sse" covers legacy servers, "stdio" locally-run ones.
 */
export type AgentMcpServerConfig =
  | {
      transport: "http" | "sse";
      url: string;
      /** Sent verbatim on every request (auth tokens ride here). */
      headers?: Record<string, string>;
    }
  | {
      transport: "stdio";
      command: string;
      args?: string[];
      env?: Record<string, string>;
    };

/**
 * A Claude Code plugin staged on disk for harnesses that can load it
 * natively. MCP servers a plugin declares are NOT loaded from the plugin —
 * the host lifts them into {@link AgentMcpServerConfig}s so every harness
 * (not just Claude Code) gets them.
 */
export interface AgentPluginConfig {
  name: string;
  /** Absolute path to the installed plugin directory. */
  path: string;
}

/** A media file sent along with a user message. */
export interface AgentAttachment {
  kind: "image" | "document";
  name: string;
  /** MIME type, e.g. "image/png", "application/pdf". */
  mediaType: string;
  dataBase64: string;
}

/** Per-turn overrides; anything unset falls back to the provider's defaults. */
export interface TurnOptions {
  model?: string;
  effort?: AgentEffort;
  /** Media sent with this turn's user message. */
  attachments?: AgentAttachment[];
}

/** What a host-supplied tool knows about the session it runs in. */
export interface ExtraToolContext {
  projectId: string;
  /** Host-side chat session id (see {@link StartSessionOpts.sessionId}). */
  sessionId?: string;
}

/**
 * A host-supplied tool injected into a harness beside its built-in set —
 * how the desktop app hands agents workspace powers (driving browser
 * tabs, terminals, tab discovery) without each harness knowing about them.
 *
 * `parameters` is a zod raw shape (`Record<string, ZodType>`), typed
 * loosely so this package stays schema-library-free; harnesses cast it
 * into their native declaration (ai-sdk `tool()`, Claude Agent SDK MCP
 * tools). Throwing from `execute` is fine — harnesses surface the message
 * to the model as the tool result.
 */
export interface ExtraTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(
    input: Record<string, unknown>,
    context: ExtraToolContext,
  ): Promise<unknown>;
}

export interface CodingAgentProvider {
  readonly name: string;

  /**
   * Prepare a session: stage plugin docs, compute instructions, allocate
   * state. This must NOT talk to the model — the transcript begins with the
   * user's first real message, sent via {@link sendMessage}.
   */
  startSession(opts: StartSessionOpts): Promise<ProviderSession>;

  sendMessage(
    session: ProviderSession,
    message: string,
    opts?: TurnOptions,
  ): AsyncIterable<AgentEvent>;

  /**
   * Abort the in-flight turn for this provider session, if any. The
   * running {@link sendMessage} stream ends (an error/done pair is fine);
   * the session itself stays usable for the next turn.
   */
  interrupt?(providerSessionId: string): void;

  /**
   * Whether this provider still holds live state for the session. Only
   * meaningful for harnesses whose sessions are in-memory (ai-sdk): a
   * `false` tells the host the session died with a restart or provider
   * rebuild, so it can re-anchor (passing {@link StartSessionOpts.history})
   * instead of running into a dead session. Durable harnesses omit it.
   */
  hasSession?(providerSessionId: string): boolean;

  /**
   * Re-run the last (failed) turn WITHOUT appending a new user message —
   * the harness already holds the conversation up to and including that
   * user message. `sanitizeReasoning` asks the harness to strip prior
   * reasoning/thinking output from its history first (recovery for
   * model-switch incompatibilities). Hosts fall back to re-sending the
   * last user message when a harness doesn't implement this.
   */
  retryTurn?(
    session: ProviderSession,
    opts?: TurnOptions & { sanitizeReasoning?: boolean },
  ): AsyncIterable<AgentEvent>;

  dispose(session: ProviderSession): Promise<void>;
}
