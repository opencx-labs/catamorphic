import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { JsonValue } from "@catamorphic/agent-protocol";
import type {
  HostToolDescriptor,
  HostToolResult,
} from "@catamorphic/agent-protocol/runner";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

/** The server key host tools are offered under unless they name one. */
export const HOST_TOOL_SERVER = "workspace";

/** The server a host tool is offered under. */
export function hostToolServer(tool: HostToolDescriptor): string {
  return tool.server ?? HOST_TOOL_SERVER;
}

function toJson(value: unknown): JsonValue {
  const parsed: JsonValue = JSON.parse(JSON.stringify(value ?? {}));
  return parsed;
}

function toCallToolResult(result: HostToolResult): CallToolResult {
  const structured = result.structured;
  return {
    content: result.content.map((part) =>
      part.type === "text"
        ? { type: "text", text: part.text }
        : { type: "image", data: part.data, mimeType: part.mimeType },
    ),
    // MCP carries structured results as an object; anything else stays in
    // the content.
    ...(structured &&
    typeof structured === "object" &&
    !Array.isArray(structured)
      ? { structuredContent: structured }
      : {}),
    ...(result.isError ? { isError: true } : {}),
  };
}

/**
 * Host tools (ADR 0198) as in-process MCP servers, one per server key
 * (`workspace` unless a tool names its own; tool ids
 * `mcp__<server>__<name>`). Their input schemas are JSON Schema from the
 * host, listed verbatim; a call runs through the host. `toolUseId` names
 * the harness's id for a call, so the host can link its record to the
 * transcript item.
 */
export function hostToolServers(input: {
  tools: readonly HostToolDescriptor[];
  call: (call: {
    name: string;
    input: JsonValue;
    itemKey?: string;
  }) => Promise<HostToolResult>;
  toolUseId: (call: {
    server: string;
    name: string;
    meta: unknown;
  }) => string | undefined;
}): Record<string, McpSdkServerConfigWithInstance> {
  const byServer = new Map<string, HostToolDescriptor[]>();
  for (const tool of input.tools) {
    const server = hostToolServer(tool);
    byServer.set(server, [...(byServer.get(server) ?? []), tool]);
  }
  const servers: Record<string, McpSdkServerConfigWithInstance> = {};
  for (const [server, tools] of byServer) {
    const mcp = new McpServer(
      { name: server, version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    mcp.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: { ...tool.inputSchema, type: "object" as const },
        // The host offers a turn only the tools it means to be in view
        // (the rest wait behind its own discovery): Claude Code's tool
        // search must not defer them, or the agent sees no browser,
        // subsessions or background commands until it searches.
        _meta: { "anthropic/alwaysLoad": true },
      })),
    }));
    mcp.server.setRequestHandler(
      CallToolRequestSchema,
      async (request): Promise<CallToolResult> => {
        const name = request.params.name;
        if (!tools.some((tool) => tool.name === name))
          return {
            content: [{ type: "text", text: `Unknown tool: ${name}` }],
            isError: true,
          };
        const itemKey = input.toolUseId({
          server,
          name,
          meta: request.params._meta,
        });
        try {
          return toCallToolResult(
            await input.call({
              name,
              input: toJson(request.params.arguments),
              ...(itemKey ? { itemKey } : {}),
            }),
          );
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: error instanceof Error ? error.message : String(error),
              },
            ],
            isError: true,
          };
        }
      },
    );
    servers[server] = { type: "sdk", name: server, instance: mcp };
  }
  return servers;
}
