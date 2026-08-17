import type { McpToolPolicy, ToolPermission } from "./desktop-api.js";

/**
 * Renderer mirror of @catamorphic/sandbox's tool-policy resolver, so the
 * two permission editors show the SAME answer the harness will compute
 * (`tool-policy.test.ts` cross-checks it against the real one). Kept
 * separate because the sandbox package is a Node bundle.
 */

const RANK: Record<ToolPermission, number> = { deny: 0, ask: 1, allow: 2 };

export const stricterPermission = (
  a: ToolPermission,
  b: ToolPermission,
): ToolPermission => (RANK[a] <= RANK[b] ? a : b);

export interface PolicyAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
}

/** One layer's answer: rule → default → auto via annotations. */
export function resolveToolPermission(
  policy: McpToolPolicy | undefined,
  toolName: string,
  annotations?: PolicyAnnotations,
): ToolPermission {
  const explicit = policy?.tools?.[toolName];
  if (explicit) return explicit;
  const fallback = policy?.default ?? "auto";
  if (fallback !== "auto") return fallback;
  return annotations?.readOnlyHint ? "allow" : "ask";
}

/** Strictest answer across layers (undefined layers are skipped). */
export function resolveAcross(
  layers: Array<McpToolPolicy | undefined>,
  toolName: string,
  annotations?: PolicyAnnotations,
): ToolPermission {
  const present = layers.filter((layer): layer is McpToolPolicy => !!layer);
  if (present.length === 0) {
    return resolveToolPermission(undefined, toolName, annotations);
  }
  return present
    .map((layer) => resolveToolPermission(layer, toolName, annotations))
    .reduce(stricterPermission);
}

/**
 * An agent's policy as a layer: its unset default is "no opinion"
 * (allow), unlike a connection's `auto` — mirrors the registry's
 * `agentLayer`.
 */
export const agentLayer = (
  policy: McpToolPolicy | undefined,
): McpToolPolicy => ({ default: "allow", ...policy });

export const PERMISSION_LABELS: Record<ToolPermission, string> = {
  allow: "Allow",
  ask: "Ask",
  deny: "Off",
};

/** Human summary of a policy: "Ask by default · 2 rules". */
export function describePolicy(policy: McpToolPolicy | undefined): string {
  if (!policy) return "Auto";
  const rules = Object.keys(policy.tools ?? {}).length;
  const head =
    !policy.default || policy.default === "auto"
      ? "Auto"
      : `${PERMISSION_LABELS[policy.default]} by default`;
  return rules > 0 ? `${head} · ${rules} rule${rules === 1 ? "" : "s"}` : head;
}
