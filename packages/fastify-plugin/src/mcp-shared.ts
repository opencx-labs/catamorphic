import type { CatamorphicCore, Identity } from "@catamorphic/core";
import { MCP_POLL_RUN_TOOL, RunNotFoundError } from "@catamorphic/core";
import { z } from "zod";

/**
 * What the plugin's MCP endpoints share beside the dispatcher
 * (`mcp-server.ts`): how a value becomes a tool result, how another
 * server's tools and results are forwarded, and the run poll tool.
 */

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
 * structured content, `isError` and `_meta` unchanged (ADR 0225). These
 * revisions require structured content to be an object, so any other
 * (which newer revisions allow) is left out, and becomes the text when the
 * server sent none. Anything that is not a tool result answers as a value,
 * never as a failure: the call has already run.
 */
export function forwardedToolResult(result: unknown): Record<string, unknown> {
  const parsed = ForwardedToolResultSchema.safeParse(result);
  if (!parsed.success) return toolValue(result);
  const { structuredContent, ...rest } = parsed.data;
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

/** A tool another MCP server declared, as a forwarding endpoint lists it. */
export interface ForwardedToolDefinition {
  name: string;
  title?: string;
  description?: string;
  inputSchema: unknown;
  outputSchema?: unknown;
  annotations?: unknown;
}
