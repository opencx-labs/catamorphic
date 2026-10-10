/**
 * Who a session serves (ADR 0055). Structurally the host's `Identity`:
 * tenant, user and — for scoped callers — the artifact refs they may
 * touch, carried opaquely (this package never interprets them). Harnesses
 * forward it on {@link ExtraToolContext} so host-supplied per-session MCP
 * servers and tools can bind to the caller (a hosting backend mints the
 * project MCP endpoint's credentials from it; the endpoint then enforces
 * the caller's scope structurally).
 */
export interface SessionCaller {
  tenantId: string;
  externalUserId: string;
  scope?: ReadonlyArray<{ readonly kind: string; readonly projectId: string }>;
}

/**
 * Lightweight description of a plugin package attached to a project, so an
 * attempt can (1) stage the plugin's docs inside the working directory for
 * filesystem discovery, and (2) prepend an "attached packages" preamble to
 * the system prompt.
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

/**
 * Normalized reasoning-effort scale shared by every harness. Each provider
 * maps it onto its native knob (thinking budgets, reasoning effort levels)
 * and CLAMPS levels it doesn't reach (Codex tops out at xhigh, OpenAI
 * reasoning effort at high); providers that have no such knob ignore it.
 * The top levels are what "ultramode" is: reasoning depth, not a mode.
 */
export type AgentEffort = "low" | "medium" | "high" | "xhigh" | "max";

/** All effort levels, low → max (UI orderings, validation). */
export const AGENT_EFFORT_LEVELS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly AgentEffort[];

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
      /** Harness hint for servers whose tools are already host-authorized. */
      defaultToolsApprovalMode?: "auto" | "prompt" | "writes" | "approve";
    }
  | {
      transport: "stdio";
      command: string;
      args?: string[];
      cwd?: string;
      /** Explicit environment names inherited by the MCP child. */
      envVars?: string[];
      env?: Record<string, string>;
      /** Harness hint for servers whose tools are already host-authorized. */
      defaultToolsApprovalMode?: "auto" | "prompt" | "writes" | "approve";
    };

/**
 * Where a harness reads its agent-wide MCP servers from: a fixed map, or a
 * getter the host keeps current. Harnesses read the getter live — at every
 * connect (built-in agent), spawn (Codex) or query (Claude Code) — so a
 * rotated OAuth token or renewed header reaches the next call without the
 * host rebuilding the provider (which would drop its live sessions).
 */
export type McpServersSource =
  | Record<string, AgentMcpServerConfig>
  | (() => Record<string, AgentMcpServerConfig>);

export function resolveMcpServers(
  source: McpServersSource | undefined,
): Record<string, AgentMcpServerConfig> {
  if (!source) return {};
  return typeof source === "function" ? source() : source;
}

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

/** Where a text attachment came from — shown on the pill, told to the model. */
export type AgentTextSource =
  | { type: "paste" }
  | {
      type: "selection";
      /** Project-relative path of the file the text was selected in. */
      filePath: string;
      /** 1-based inclusive line range, when known. */
      startLine?: number;
      endLine?: number;
    }
  | { type: "url"; url: string }
  | { type: "path"; path: string }
  | {
      /**
       * An open workspace tab (browser page, editor, terminal, chat…)
       * dragged into the composer. The key addresses it through the
       * workspace tools (`read_tab`); title/url/filePath are what
       * the pill shows and what the model reads without a tool call.
       */
      type: "tab";
      key: string;
      kind: string;
      title: string;
      url?: string;
      filePath?: string;
    };

/** A media file sent along with a user message. */
export interface AgentMediaAttachment {
  kind: "image" | "document";
  name: string;
  /** MIME type, e.g. "image/png", "application/pdf". */
  mediaType: string;
  dataBase64: string;
}

/**
 * Text context sent along with a user message: a big paste, an editor
 * selection, a URL, a file path. Universal — every harness can take text —
 * and delivered as structured context beside the prose, never spliced into
 * the user's own words.
 */
export interface AgentTextAttachment {
  kind: "text";
  /** Short label (first line of a paste, `file.md · 12–24`, the URL…). */
  name: string;
  text: string;
  source: AgentTextSource;
}

export type AgentAttachment = AgentMediaAttachment | AgentTextAttachment;

/**
 * A model reached through the connection gateway from inside a sandbox
 * (ADR 0180). The harness process there sends the provider's own HTTP API
 * to `baseUrl` with the session's grant, read from `keyFile` at each use,
 * as its API key; the gateway forwards with the real key.
 */
export interface SandboxModelGateway {
  /** The Environment binding alias of the model connection. */
  alias: string;
  /** Which HTTP API the connection's provider speaks. */
  api: "anthropic" | "openai";
  /**
   * Where the provider's paths go: `<baseUrl>/v1/messages` for Anthropic
   * (an `ANTHROPIC_BASE_URL`), `<baseUrl>/responses` for OpenAI (an
   * `OPENAI_BASE_URL`).
   */
  baseUrl: string;
  /** Absolute sandbox path of the file holding the current grant. */
  keyFile: string;
}

/** What a host-supplied tool knows about the session it runs in. */
export interface ExtraToolContext {
  projectId: string;
  /** The chat session the tool's turn belongs to. */
  sessionId?: string;
  /** The turn the tool runs in, when the host knows it. */
  turnId?: string;
  /** Checkout or sandbox directory selected by the host for this turn. */
  workingDirectory?: string;
  /** Who the session serves. */
  caller?: SessionCaller;
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
