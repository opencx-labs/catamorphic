import type { AgentMcpServerConfig } from "@catamorphic/sandbox";
import {
  Client,
  SSEClientTransport,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

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
}

export interface ConnectedMcpServer {
  tools: McpToolInfo[];
  /** Negotiated protocol revision (e.g. "2026-07-28"), when known. */
  protocolVersion?: string;
  /** Call a tool; the result is flattened to model-readable text. */
  callTool(name: string, args: Record<string, unknown>): Promise<string>;
  close(): Promise<void>;
}

const CLIENT_INFO = { name: "catamorphic-desktop", version: "1.0.0" };

function buildClient(): Client {
  return new Client(CLIENT_INFO, {
    // Prefer the stateless 2026-07-28 protocol, probe-first with a
    // conservative fallback to the legacy handshake era.
    versionNegotiation: { mode: "auto" },
  });
}

async function connectTransport(config: AgentMcpServerConfig) {
  if (config.transport === "stdio") {
    const client = buildClient();
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
    const client = buildClient();
    await client.connect(new SSEClientTransport(url, { requestInit }));
    return client;
  }

  // Streamable HTTP first; legacy HTTP+SSE servers answer POSTs with 4xx/405,
  // so a failed connect falls back to the SSE transport before giving up.
  try {
    const client = buildClient();
    await client.connect(
      new StreamableHTTPClientTransport(url, { requestInit }),
    );
    return client;
  } catch (streamableError) {
    try {
      const client = buildClient();
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
): Promise<ConnectedMcpServer> {
  const client = await connectTransport(config);
  const listed = await client.listTools();
  const tools: McpToolInfo[] = listed.tools.map((tool) => ({
    name: tool.name,
    description: tool.description ?? "",
    inputSchema: (tool.inputSchema ?? { type: "object" }) as Record<
      string,
      unknown
    >,
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
