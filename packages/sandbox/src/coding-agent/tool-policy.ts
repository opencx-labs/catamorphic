/**
 * Per-tool permissions for MCP servers, harness-neutral.
 *
 * A policy says, per server, what happens when an agent reaches for one of
 * its tools: run it (`allow`), ask the user first (`ask`), or refuse
 * (`deny`). Rules are keyed by tool name; `default` covers the rest, and
 * the special default `auto` reads the tool's spec annotations — a
 * `readOnlyHint` tool runs, anything else asks.
 *
 * Policies compose by INTERSECTION: the stricter answer wins
 * (deny < ask < allow). That is what lets the same shape live at two
 * scopes without a precedence table — the credential owner's connection
 * policy is a ceiling, an agent's own policy can only narrow it — and it
 * survives the remote case, where a hosting backend defines the agent and
 * a member's local settings can still hold it back.
 */

export type ToolPermission = "allow" | "ask" | "deny";

/**
 * Server key of the project's own workflow-tools MCP server (ADR 0042), the
 * one session-scoped server every harness mounts. Policies keyed by it
 * (an agent's `toolPolicies.catamorphic`, a role's) narrow which of the
 * project's workflows an agent may run.
 */
export const PROJECT_TOOLS_SERVER_KEY = "catamorphic";

export interface McpToolPolicy {
  /** What tools without a rule get. `auto` = allow read-only, ask others. */
  default?: ToolPermission | "auto";
  /** Tool name → permission. */
  tools?: Record<string, ToolPermission>;
}

/** The subset of MCP tool annotations the resolver reads. */
export interface ToolPolicyAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
}

const RANK: Record<ToolPermission, number> = { deny: 0, ask: 1, allow: 2 };

/** The stricter of two permissions. */
export function stricterPermission(
  a: ToolPermission,
  b: ToolPermission,
): ToolPermission {
  return RANK[a] <= RANK[b] ? a : b;
}

/** What `auto` means for one tool: run read-only tools, ask about others. */
export function permissionFromAnnotations(
  annotations: ToolPolicyAnnotations | undefined,
): ToolPermission {
  return annotations?.readOnlyHint === true ? "allow" : "ask";
}

/** Resolve one policy for one tool (annotations decide `auto`). */
export function resolveToolPermission(
  policy: McpToolPolicy | undefined,
  toolName: string,
  annotations?: ToolPolicyAnnotations,
): ToolPermission {
  const explicit =
    policy?.tools && Object.hasOwn(policy.tools, toolName)
      ? policy.tools[toolName]
      : undefined;
  if (explicit) return explicit;
  const fallback = policy?.default ?? "auto";
  return fallback === "auto"
    ? permissionFromAnnotations(annotations)
    : fallback;
}

/**
 * The layers that apply to one server (connection ceiling, agent
 * narrowing, …). Resolution is the strictest answer across layers; layers
 * stay separate rather than being pre-merged because `auto` needs the
 * tool's annotations, which are only known at call time.
 */
export type McpToolPolicyLayers = McpToolPolicy[];

export function resolveToolPermissionAcross(
  layers: McpToolPolicyLayers | undefined,
  toolName: string,
  annotations?: ToolPolicyAnnotations,
): ToolPermission {
  if (!layers || layers.length === 0) {
    return resolveToolPermission(undefined, toolName, annotations);
  }
  return layers
    .map((layer) => resolveToolPermission(layer, toolName, annotations))
    .reduce(stricterPermission);
}

/**
 * Merge two policy maps by concatenating layers per server key — the shape
 * harnesses use to put a session's caller layers (ADR 0055) beside the
 * provider's own. Concatenation is intersection under
 * {@link resolveToolPermissionAcross}, so merging can only narrow.
 */
export function mergePolicyLayers(
  base: Record<string, McpToolPolicyLayers> | undefined,
  extra: Record<string, McpToolPolicyLayers> | undefined,
): Record<string, McpToolPolicyLayers> | undefined {
  if (!extra || Object.keys(extra).length === 0) return base;
  const merged: Record<string, McpToolPolicyLayers> = { ...(base ?? {}) };
  for (const [key, layers] of Object.entries(extra)) {
    merged[key] = [...(merged[key] ?? []), ...layers];
  }
  return merged;
}

/**
 * A narrowing layer's semantics (an agent's, a role's): an unset or `auto`
 * default means "no opinion" — allow, so the intersection is whatever the
 * layers below say — and only explicit rules can change the answer.
 * Without this asymmetry a layer that pins one tool would narrow every
 * other tool of the server to "ask" (ADR 0054 §7).
 */
export function narrowingLayer(policy: McpToolPolicy): McpToolPolicy {
  return {
    ...policy,
    default:
      policy.default && policy.default !== "auto" ? policy.default : "allow",
  };
}

/**
 * The stable, tool-name-safe server key for a connection or connector name
 * (`mcp__<key>__<tool>` in Claude Code, TOML table keys in Codex). Hosts and
 * role/agent definitions key policies by this, so "Slack" and "slack" name
 * the same server everywhere.
 */
export function serverKeyOf(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** A request the harness raises when a tool resolves to `ask`. */
export interface ToolPermissionRequest {
  /** Host chat session the call belongs to, when the harness knows it —
   * lets a host route the ask to the right conversation. */
  sessionId?: string;
  /** Server key the harness knows the connection by (`mcp__<server>__…`). */
  server: string;
  tool: string;
  description?: string;
  input: Record<string, unknown>;
  annotations?: ToolPolicyAnnotations;
}

export type ToolPermissionDecision =
  | { decision: "allow"; remember?: "always" }
  | { decision: "deny" };

export type ToolPermissionHandler = (
  request: ToolPermissionRequest,
) => Promise<ToolPermissionDecision>;
