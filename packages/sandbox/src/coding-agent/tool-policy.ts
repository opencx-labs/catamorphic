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

/** What a gate decides for one call: run it, or refuse with a message the
 * model can read (turned off, nobody to ask, user declined, interrupted). */
export type ToolGateVerdict =
  | { allowed: true }
  | { allowed: false; message: string };

export interface ToolGateCall {
  /** Server key the harness knows the connection by. */
  server: string;
  tool: string;
  input: Record<string, unknown>;
  /** The merged layers for that server; undefined = unpoliced server. */
  layers: McpToolPolicyLayers | undefined;
  annotations?: ToolPolicyAnnotations;
  description?: string;
  sessionId?: string;
  /** The turn's abort — an interrupted turn abandons a parked ask. */
  abortSignal?: AbortSignal;
}

/**
 * The one allow / ask / deny decision every harness runs before an MCP tool
 * call (ADR 0054, plus ADR 0055's caller layers): resolve across the layers
 * (annotations decide `auto`), short-circuit a remembered "always allow" —
 * only for ASK, a later Off still wins because policies are read live —
 * refuse `deny` and "ask with nobody to ask", otherwise raise the host's ask
 * and honour its answer.
 *
 * Harnesses adapt the verdict to their native shape (thrown error,
 * PermissionResult, spawn-time filter); the state — remembered keys and the
 * ask handler — lives here so wording, remember semantics and abort handling
 * exist once.
 */
export class ToolGate {
  private readonly remembered = new Set<string>();

  constructor(private readonly ask?: ToolPermissionHandler) {}

  async decide(call: ToolGateCall): Promise<ToolGateVerdict> {
    if (!call.layers) return { allowed: true };
    const key = `${call.server} ${call.tool}`;
    const permission = resolveToolPermissionAcross(
      call.layers,
      call.tool,
      call.annotations,
    );
    if (permission === "allow") return { allowed: true };
    if (permission === "ask" && this.remembered.has(key)) {
      return { allowed: true };
    }
    if (permission === "deny") {
      return {
        allowed: false,
        message: `The tool "${call.tool}" on ${call.server} is turned off in this connection's permissions.`,
      };
    }
    if (!this.ask) {
      return {
        allowed: false,
        message: `The tool "${call.tool}" on ${call.server} needs the user's permission, and there is no one to ask in this context.`,
      };
    }
    const asked = this.ask({
      ...(call.sessionId ? { sessionId: call.sessionId } : {}),
      server: call.server,
      tool: call.tool,
      ...(call.description !== undefined
        ? { description: call.description }
        : {}),
      input: call.input,
      ...(call.annotations ? { annotations: call.annotations } : {}),
    });
    let answer: ToolPermissionDecision;
    try {
      answer = call.abortSignal
        ? await Promise.race([asked, rejectOnAbort(call.abortSignal)])
        : await asked;
    } catch (error) {
      return {
        allowed: false,
        message:
          error instanceof Error
            ? error.message
            : "The permission request failed.",
      };
    }
    if (answer.decision !== "allow") {
      return {
        allowed: false,
        message: `The user declined to let you use "${call.tool}" on ${call.server} for this call.`,
      };
    }
    if (answer.remember === "always") this.remembered.add(key);
    return { allowed: true };
  }
}

function rejectOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    const abort = () =>
      reject(new Error("The turn was interrupted before the user answered."));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}
