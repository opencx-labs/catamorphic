/**
 * MCP Apps host dialect (extension `io.modelcontextprotocol/ui`, spec
 * 2026-01-26). When a Catamorphic app bundle is served to a standard MCP
 * Apps host (Claude, ChatGPT, VS Code, …) instead of a Catamorphic host,
 * the guest speaks JSON-RPC over postMessage: workflow calls become
 * `tools/call` against the publishing server's tools (see
 * `@catamorphic/app-mcp`), run polling becomes the `catamorphic_poll_run`
 * tool, and height reports become `ui/notifications/size-changed`.
 *
 * Detection is evidence-based and race-free: the guest sends
 * `ui/initialize` at boot (Catamorphic hosts ignore unknown shapes); an
 * initialize RESULT proves an MCP Apps host and flips the bridge's mode.
 * Until then the bridge behaves exactly as it always has — a Catamorphic
 * host never sees any difference.
 */

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export function isJsonRpcResponse(value: unknown): value is JsonRpcResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { jsonrpc?: unknown }).jsonrpc === "2.0" &&
    typeof (value as { id?: unknown }).id === "number" &&
    !("method" in (value as object))
  );
}

/** Name of the run-polling tool the Catamorphic app MCP server exposes. */
export const POLL_RUN_TOOL = "catamorphic_poll_run";

/** The `tools/call` result shape we consume (subset of the MCP schema). */
export interface McpToolCallResult {
  content?: Array<{ type?: string; text?: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

/**
 * The value a tool call produced, preferring structured output. Text
 * content is parsed as JSON when possible (the app server round-trips
 * workflow outputs as JSON), otherwise returned as-is.
 */
export function toolResultValue(result: McpToolCallResult): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = (result.content ?? [])
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
  if (text === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function toolResultErrorMessage(result: McpToolCallResult): string {
  const value = toolResultValue(result);
  return typeof value === "string" ? value : JSON.stringify(value);
}
