/**
 * A stdio MCP server for recording replay fixtures: one `lookup` tool that
 * answers with text and structured content. Run it with Bun or Node.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const server = new McpServer(
  { name: "fixture", version: "1.0.0" },
  { capabilities: { tools: {} } },
);
server.server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "lookup",
      description: "Look a word up in the fixture dictionary.",
      inputSchema: {
        type: "object" as const,
        properties: { word: { type: "string" } },
        required: ["word"],
      },
    },
  ],
}));
server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const word = String(request.params.arguments?.word ?? "");
  return {
    content: [{ type: "text", text: `${word}: a fixture word` }],
    structuredContent: { word, meaning: "a fixture word" },
  };
});
await server.connect(new StdioServerTransport());
