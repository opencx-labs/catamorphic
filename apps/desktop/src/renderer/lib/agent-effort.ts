import type {
  AgentEffort,
  AgentInfo,
  HarnessModelInfo,
} from "./desktop-api.js";

type Agent = Pick<AgentInfo, "harness" | "provider">;

/**
 * Every reasoning effort, lowest first, by the names Claude Code and Codex
 * give them. Neither harness labels or describes its levels, so pickers and
 * the chat's status show these names as they are, lowercase, and nothing
 * beside them.
 */
export const EFFORT_LEVELS: readonly AgentEffort[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** Values the shipped adapters can forward without silently clamping them. */
export function supportedEfforts(
  agent: Agent | undefined,
  model?: HarnessModelInfo,
): readonly AgentEffort[] {
  if (!agent) return [];
  if (model?.supportsEffort === false) return [];
  if (model?.supportedEffortLevels) return model.supportedEffortLevels;
  if (agent.harness === "codex") return EFFORT_LEVELS;
  if (agent.harness === "ai-sdk" && agent.provider === "openrouter") return [];
  if (agent.harness === "ai-sdk" && agent.provider === "openai")
    return ["low", "medium", "high"];
  return EFFORT_LEVELS;
}

/** Match the Codex adapter's thread options and the built-in agent's provider mapping. */
export function effectiveEffort(
  agent: Agent | undefined,
  effort: AgentEffort | null | undefined,
  model?: HarnessModelInfo,
): AgentEffort | null {
  const supported = supportedEfforts(agent, model);
  if (!effort || supported.length === 0) return null;
  if (supported.includes(effort)) return effort;
  return supported.at(-1) ?? null;
}
