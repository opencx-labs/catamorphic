import { randomBytes } from "node:crypto";
import {
  hasTokenScope,
  type Identity,
  type TokenScope,
} from "@catamorphic/core";
import type { McpTool } from "./mcp-server.js";
import type { RouteContext } from "./plugin.js";

/**
 * Which OAuth scope each MCP tool needs (ADR 0347). A member's roles
 * decide what they may do; the scopes of the token their client holds
 * narrow that again, so a client is shown, and may call, only what its
 * person consented to.
 */

const DOCUMENT_WRITES = new Set(["documents_write", "documents_delete"]);
const PROGRAM_WRITES = new Set([
  "program_write",
  "program_files",
  "program_check",
  "program_discard",
  "propose_change",
]);
const PUBLISHES = new Set([
  "program_deploy",
  "publish_document",
  "revoke_publication",
  "share_create",
  "share_revoke",
]);

/** The scope a tool needs: its own, or the one its name and effect imply. */
export function toolScope(tool: McpTool): TokenScope {
  if (tool.scope) return tool.scope;
  const name = String(tool.definition.name);
  if (DOCUMENT_WRITES.has(name)) return "documents:write";
  if (PUBLISHES.has(name)) return "program:publish";
  if (PROGRAM_WRITES.has(name)) return "program:write";
  const annotations = Object(tool.definition.annotations);
  // Anything else that acts runs something: a workflow, a watcher, a share.
  return annotations.readOnlyHint === true ? "work:read" : "sessions:run";
}

/** Whether the caller's token lets it see and call the tool. */
export function mayCallTool(identity: Identity, tool: McpTool): boolean {
  return hasTokenScope(identity, toolScope(tool));
}

/** The tools the caller's token hides, with the scope each would need. */
export function withheldTools(
  identity: Identity,
  tools: readonly McpTool[],
): ReadonlyMap<string, string> {
  return new Map(
    tools
      .filter((tool) => !mayCallTool(identity, tool))
      .map((tool) => [String(tool.definition.name), toolScope(tool)]),
  );
}

// Replica memory (c): a host with several replicas configures the secret,
// so all of them build the same one; this one serves a single process.
const PROCESS_SECRET = randomBytes(32).toString("hex");

/** The secret that signs the state a wait hands out (MRTR). */
export function mcpStateSecret(ctx: RouteContext): string {
  return ctx.mcp?.stateSecret ?? PROCESS_SECRET;
}
