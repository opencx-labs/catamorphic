/**
 * MCP serving for hosts: an endpoint that forwards another MCP server's
 * tools the way the plugin's own connection endpoint does (ADR 0225).
 */
export {
  type ForwardedToolDefinition,
  McpRequestError,
  serveForwardedTools,
  toolError,
} from "./mcp-shared.js";
