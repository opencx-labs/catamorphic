import type { AgentMcpServerConfig } from "@catamorphic/sandbox";
import {
  Client,
  SSEClientTransport,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  type ElicitHandler,
  type ElicitResult,
  parseElicitRequest,
} from "./elicitation.js";

/** Extra behavior a caller can wire into a connection. */
export interface ConnectMcpOpts {
  /**
   * How to answer `elicitation/create` requests — a form or a URL the
   * server needs the user to complete (OAuth handoffs, config). Declaring
   * it advertises the elicitation capability (form + url) and registers
   * the handler; on the stateless era the SAME handler fulfils MRTR
   * `input_required` rounds. Omit it and the server sees no elicitation
   * capability, so it never asks.
   */
  onElicit?: ElicitHandler;
}

/** An icon a server/tool exposes (2025-11-25 icons metadata). */
export interface McpIcon {
  src: string;
  mimeType?: string;
  sizes?: string;
  theme?: "light" | "dark";
}

/**
 * Best displayable icon from an `icons` array: https/data src only (spec
 * security rule — never javascript:/file:/etc.), preferring a themeless or
 * light icon and an SVG/PNG mime type.
 */
export function pickIcon(icons: unknown): string | undefined {
  if (!Array.isArray(icons)) return undefined;
  const usable = icons
    .filter(
      (icon): icon is McpIcon =>
        typeof icon === "object" &&
        icon !== null &&
        typeof (icon as McpIcon).src === "string" &&
        /^(https:\/\/|data:image\/)/i.test((icon as McpIcon).src),
    )
    .sort((a, b) => iconScore(b) - iconScore(a));
  return usable[0]?.src;
}

function iconScore(icon: McpIcon): number {
  let score = 0;
  if (icon.theme !== "dark") score += 2;
  if (icon.mimeType === "image/svg+xml") score += 1;
  return score;
}

/**
 * MCP client layer built on the official v2 SDK. Connections negotiate
 * protocol versions automatically (`versionNegotiation: { mode: "auto" }`):
 * the client probes with `server/discover` and speaks the stateless
 * 2026-07-28 revision when the server supports it, falling back to the
 * legacy `initialize`-handshake revisions (≤2025-11-25) otherwise — so
 * every server works, and the newest protocol always wins when available.
 */

export interface McpToolInfo {
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments. */
  inputSchema: Record<string, unknown>;
  /** The tool's `_meta`, when present (MCP Apps ui linkage lives here). */
  meta?: Record<string, unknown>;
}

export interface McpResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
  /** Base64 payload for binary resources. */
  blob?: string;
  /** The resource-level `_meta` (MCP Apps CSP/permission envelope). */
  meta?: Record<string, unknown>;
}

export interface ConnectedMcpServer {
  tools: McpToolInfo[];
  /** Negotiated protocol revision (e.g. "2026-07-28"), when known. */
  protocolVersion?: string;
  /** Call a tool; the result is flattened to model-readable text. */
  callTool(name: string, args: Record<string, unknown>): Promise<string>;
  /** Call a tool and return the raw MCP result (structured content etc.). */
  callToolRaw(
    name: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  /** Read a resource (e.g. a `ui://` app template). */
  readResource(uri: string): Promise<McpResourceContent>;
  close(): Promise<void>;
}

/**
 * MCP Apps (extension io.modelcontextprotocol/ui): the `ui://` template a
 * tool renders with, when it declares one. Reads the spec's nested
 * `_meta.ui.resourceUri`, the deprecated flat `ui/resourceUri` key, and
 * OpenAI's pre-standard `openai/outputTemplate` alias.
 */
export function uiResourceUri(tool: McpToolInfo): string | undefined {
  const meta = tool.meta;
  if (!meta) return undefined;
  const ui = meta.ui;
  if (ui && typeof ui === "object") {
    const uri = (ui as { resourceUri?: unknown }).resourceUri;
    if (typeof uri === "string") return uri;
  }
  const flat = meta["ui/resourceUri"];
  if (typeof flat === "string") return flat;
  const openai = meta["openai/outputTemplate"];
  if (typeof openai === "string") return openai;
  return undefined;
}

const CLIENT_INFO = { name: "catamorphic-desktop", version: "1.0.0" };

function buildClient(opts?: ConnectMcpOpts): Client {
  const client = new Client(CLIENT_INFO, {
    // Prefer the stateless 2026-07-28 protocol, probe-first with a
    // conservative fallback to the legacy handshake era.
    versionNegotiation: { mode: "auto" },
    // Advertise elicitation only when the host can render it; both modes.
    ...(opts?.onElicit
      ? { capabilities: { elicitation: { form: {}, url: {} } } }
      : {}),
  });
  if (opts?.onElicit) {
    const handler = opts.onElicit;
    // Registered before connect: fields both legacy server→client
    // `elicitation/create` requests AND (auto-fulfilled) MRTR
    // `input_required` rounds on the stateless era.
    client.setRequestHandler("elicitation/create", async (request) => {
      const parsed = parseElicitRequest(
        (request as { params?: unknown }).params,
      );
      const result = parsed
        ? await handler(parsed)
        : ({ action: "decline" } as ElicitResult);
      // The SDK validates/narrows the result against ElicitResultSchema;
      // our neutral shape is a structural subset, cast at the boundary.
      return result as never;
    });
  }
  return client;
}

async function connectTransport(
  config: AgentMcpServerConfig,
  opts?: ConnectMcpOpts,
) {
  if (config.transport === "stdio") {
    const client = buildClient(opts);
    await client.connect(
      new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: { ...(process.env as Record<string, string>), ...config.env },
        stderr: "ignore",
      }),
    );
    return client;
  }

  const url = new URL(config.url);
  const requestInit = config.headers ? { headers: config.headers } : undefined;
  if (config.transport === "sse") {
    const client = buildClient(opts);
    await client.connect(new SSEClientTransport(url, { requestInit }));
    return client;
  }

  // Streamable HTTP first; legacy HTTP+SSE servers answer POSTs with 4xx/405,
  // so a failed connect falls back to the SSE transport before giving up.
  try {
    const client = buildClient(opts);
    await client.connect(
      new StreamableHTTPClientTransport(url, { requestInit }),
    );
    return client;
  } catch (streamableError) {
    try {
      const client = buildClient(opts);
      await client.connect(new SSEClientTransport(url, { requestInit }));
      return client;
    } catch {
      throw streamableError;
    }
  }
}

/** Result content flattened to text the model (or a settings pane) can read. */
export function flattenToolResult(result: {
  content?: Array<Record<string, unknown>>;
  structuredContent?: unknown;
  isError?: boolean;
}): string {
  const parts: string[] = [];
  for (const block of result.content ?? []) {
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    } else if (block.type === "resource" || block.type === "resource_link") {
      parts.push(JSON.stringify(block));
    }
  }
  if (parts.length === 0 && result.structuredContent !== undefined) {
    parts.push(JSON.stringify(result.structuredContent, null, 2));
  }
  const text = parts.join("\n") || "(empty result)";
  if (result.isError) {
    throw new Error(text);
  }
  return text;
}

export async function connectMcpServer(
  config: AgentMcpServerConfig,
  opts?: ConnectMcpOpts,
): Promise<ConnectedMcpServer> {
  const client = await connectTransport(config, opts);
  const listed = await client.listTools();
  const tools: McpToolInfo[] = listed.tools.map((tool) => ({
    name: tool.name,
    description: tool.description ?? "",
    inputSchema: (tool.inputSchema ?? { type: "object" }) as Record<
      string,
      unknown
    >,
    ...((tool as { _meta?: Record<string, unknown> })._meta
      ? { meta: (tool as { _meta?: Record<string, unknown> })._meta }
      : {}),
  }));
  return {
    tools,
    protocolVersion: client.getDiscoverResult() ? "2026-07-28" : undefined,
    async callTool(name, args) {
      const result = await client.callTool({ name, arguments: args });
      return flattenToolResult(
        result as Parameters<typeof flattenToolResult>[0],
      );
    },
    async callToolRaw(name, args) {
      return (await client.callTool({ name, arguments: args })) as Record<
        string,
        unknown
      >;
    },
    async readResource(uri) {
      const result = await client.readResource({ uri });
      const content = (
        result as {
          contents?: Array<{
            uri?: string;
            mimeType?: string;
            text?: string;
            blob?: string;
            _meta?: Record<string, unknown>;
          }>;
        }
      ).contents?.[0];
      if (!content) throw new Error(`Resource ${uri} returned no contents`);
      return {
        uri: content.uri ?? uri,
        mimeType: content.mimeType,
        text: content.text,
        blob: content.blob,
        ...(content._meta ? { meta: content._meta } : {}),
      };
    },
    close: () => client.close(),
  };
}

export interface McpConnectionProbe {
  ok: boolean;
  toolCount?: number;
  toolNames?: string[];
  protocolVersion?: string;
  error?: string;
}

/** One-shot health probe for the Settings UI: connect, list tools, close. */
export async function probeMcpServer(
  config: AgentMcpServerConfig,
): Promise<McpConnectionProbe> {
  try {
    const server = await connectMcpServer(config);
    const probe: McpConnectionProbe = {
      ok: true,
      toolCount: server.tools.length,
      toolNames: server.tools.map((tool) => tool.name).slice(0, 50),
      protocolVersion: server.protocolVersion,
    };
    await server.close().catch(() => {});
    return probe;
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
