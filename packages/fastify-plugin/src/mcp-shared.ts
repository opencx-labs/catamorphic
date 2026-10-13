import type { CatamorphicCore, Identity } from "@catamorphic/core";
import { MCP_POLL_RUN_TOOL, RunNotFoundError } from "@catamorphic/core";
import type { FastifyReply } from "fastify";
import { z } from "zod";

/**
 * The JSON-RPC / MCP plumbing shared by the plugin's MCP endpoints — the
 * apps server (`/projects/:id/apps-mcp`) and the workflow-tools server
 * (`/projects/:id/mcp`). Both are stateless Streamable-HTTP handlers
 * speaking the `initialize`-handshake protocol era (≤2025-11-25): requests
 * are independent, no sessions, notifications answered with a bare 202.
 */

export interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

export const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  "2024-11-05",
  "2025-03-26",
  "2025-06-18",
  "2025-11-25",
]);
export const DEFAULT_PROTOCOL_VERSION = "2025-06-18";

/** The requested revision when supported, our default otherwise. */
export function negotiateProtocolVersion(requested: unknown): string {
  return typeof requested === "string" &&
    SUPPORTED_PROTOCOL_VERSIONS.has(requested)
    ? requested
    : DEFAULT_PROTOCOL_VERSION;
}

/** A dispatch failure that should ride a specific JSON-RPC error code. */
export class McpRequestError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "McpRequestError";
  }
}

/**
 * The stateless request shell both endpoints share: body-shape validation,
 * the notification 202, missing-method rejection, and error mapping.
 * `dispatch` returns the JSON-RPC result for a method; it throws
 * {@link McpRequestError} for coded failures (-32601 method-not-found,
 * -32602 bad params) and anything else becomes -32603.
 */
export async function handleMcpPost(
  reply: FastifyReply,
  body: unknown,
  dispatch: (
    method: string,
    params: Record<string, unknown>,
  ) => Promise<unknown>,
): Promise<FastifyReply> {
  const message = body as JsonRpcMessage | null;
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return rpcError(reply, null, -32600, "Expected a single JSON-RPC message");
  }
  // Notifications (initialized, cancelled, …) need no body in return.
  if (message.id === undefined || message.id === null) {
    return reply.status(202).send();
  }
  if (typeof message.method !== "string") {
    return rpcError(reply, message.id, -32600, "Missing method");
  }
  try {
    const result = await dispatch(message.method, message.params ?? {});
    return rpcResult(reply, message.id, result);
  } catch (error) {
    if (error instanceof McpRequestError) {
      return rpcError(reply, message.id, error.code, error.message);
    }
    return rpcError(
      reply,
      message.id,
      -32603,
      error instanceof Error ? error.message : "Internal error",
    );
  }
}

export function rpcResult(
  reply: FastifyReply,
  id: number | string,
  result: unknown,
): FastifyReply {
  return reply
    .header("content-type", "application/json")
    .send({ jsonrpc: "2.0", id, result });
}

export function rpcError(
  reply: FastifyReply,
  id: number | string | null,
  code: number,
  message: string,
): FastifyReply {
  return reply
    .header("content-type", "application/json")
    .send({ jsonrpc: "2.0", id, error: { code, message } });
}

/**
 * Tool result: JSON text for model readability plus `structuredContent`
 * for structured consumers. MCP defines structured content as a JSON
 * object, and clients such as Claude Code reject anything else, so arrays
 * and primitives ride the text channel alone.
 */
export function toolValue(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: "text", text: JSON.stringify(value) ?? "null" }],
    ...(typeof value === "object" && value !== null && !Array.isArray(value)
      ? { structuredContent: value }
      : {}),
  };
}

export function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * Another MCP server's tool, listed as that server declared it (ADR 0225).
 * These endpoints speak revisions where an output schema describes an
 * object, so any other is left out: advertising it would make clients
 * reject the results it describes.
 */
export function forwardedTool(tool: {
  name: string;
  title?: string;
  description?: string;
  inputSchema: unknown;
  outputSchema?: unknown;
  annotations?: unknown;
}): Record<string, unknown> {
  return {
    name: tool.name,
    ...(tool.title ? { title: tool.title } : {}),
    ...(tool.description ? { description: tool.description } : {}),
    inputSchema: tool.inputSchema,
    ...(isObjectSchema(tool.outputSchema)
      ? { outputSchema: tool.outputSchema }
      : {}),
    ...(tool.annotations ? { annotations: tool.annotations } : {}),
  };
}

const ForwardedToolResultSchema = z.looseObject({
  content: z.array(z.unknown()),
  structuredContent: z.unknown().optional(),
});

/**
 * Another MCP server's tool result, forwarded as it was sent: content,
 * structured content, `isError` and `_meta` unchanged (ADR 0225). Only
 * structured content that is not an object (which newer revisions allow)
 * rides the text content instead, as these revisions require.
 */
export function forwardedToolResult(result: unknown): Record<string, unknown> {
  const { structuredContent, ...rest } =
    ForwardedToolResultSchema.parse(result);
  if (structuredContent === undefined) return rest;
  if (isObject(structuredContent)) return { ...rest, structuredContent };
  return rest.content.length > 0
    ? rest
    : {
        ...rest,
        content: [{ type: "text", text: JSON.stringify(structuredContent) }],
      };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isObjectSchema(schema: unknown): boolean {
  return isObject(schema) && schema.type === "object";
}

/**
 * Shared contract with `@catamorphic/app`'s MCP-host guest adapter (which
 * duplicates the name — it cannot depend on core).
 */
export const POLL_RUN_TOOL = MCP_POLL_RUN_TOOL;

/** The poll tool served beside the real tools on both MCP endpoints. */
export const POLL_RUN_TOOL_DEFINITION: Record<string, unknown> = {
  name: POLL_RUN_TOOL,
  annotations: { readOnlyHint: true },
  description:
    "Poll a workflow run by its runId — one started asynchronously or one " +
    "that detached mid-call. Returns the run's status, output (once " +
    "completed), and batch progress.",
  inputSchema: {
    type: "object",
    properties: { runId: { type: "string" } },
    required: ["runId"],
  },
};

/** The poll tool's shared implementation, same on both endpoints. */
export async function callPollRunTool(
  core: CatamorphicCore,
  identity: Identity,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const runId = typeof args.runId === "string" ? args.runId : "";
  try {
    return toolValue(await fetchRunSnapshot(core, identity, runId));
  } catch (error) {
    if (error instanceof RunNotFoundError) return toolError("Run not found");
    throw error;
  }
}

export interface RunSnapshotShape {
  runId: string;
  status: string;
  output: unknown;
  error: string | null;
  progress?: {
    discovered: number;
    succeeded: number;
    failed: number;
    skipped: number;
  };
}

/** Mirrors the in-product broker's run snapshot (AppMount's shape). */
export async function fetchRunSnapshot(
  core: CatamorphicCore,
  identity: Identity,
  runId: string,
): Promise<RunSnapshotShape> {
  const run = await core.runs.get({ identity, runId });
  const batch = (
    run as {
      batchScopes?: Array<{
        discovered: number;
        succeeded: number;
        failed: number;
        skipped: number;
      }>;
    }
  ).batchScopes?.[0];
  return {
    runId: run.id,
    status: run.status,
    output: (run as { result?: unknown }).result ?? null,
    error: (run as { error?: string | null }).error ?? null,
    ...(batch
      ? {
          progress: {
            discovered: batch.discovered,
            succeeded: batch.succeeded,
            failed: batch.failed,
            skipped: batch.skipped,
          },
        }
      : {}),
  };
}
