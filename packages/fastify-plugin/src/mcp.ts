/**
 * MCP serving for hosts: an endpoint that forwards another MCP server's
 * tools the way the plugin's own connection endpoint does (ADR 0225), on
 * the dispatcher every MCP endpoint shares (ADR 0345).
 */
export {
  MCP_ERROR,
  McpError,
  serveForwardedTools,
} from "./mcp-server.js";
export { type ForwardedToolDefinition, toolError } from "./mcp-shared.js";
