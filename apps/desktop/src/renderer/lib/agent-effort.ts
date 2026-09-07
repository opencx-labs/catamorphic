import type {
  AgentEffort,
  AgentInfo,
  HarnessModelInfo,
} from "./desktop-api.js";

type Agent = Pick<AgentInfo, "harness" | "provider">;

/** Values the shipped adapters can forward without silently clamping them. */
export function supportedEfforts(
  agent: Agent | undefined,
  model?: HarnessModelInfo,
): readonly AgentEffort[] {
  if (!agent) return [];
  if (model?.supportsEffort === false) return [];
  if (model?.supportedEffortLevels) return model.supportedEffortLevels;
  if (agent.harness === "codex")
    return ["low", "medium", "high", "xhigh", "max"];
  if (agent.harness === "ai-sdk" && agent.provider === "openrouter") return [];
  if (agent.harness === "ai-sdk" && agent.provider === "openai")
    return ["low", "medium", "high"];
  return ["low", "medium", "high", "xhigh", "max"];
}

/** Match CodexAgent.threadOptions and AiSdkCodingAgent's provider mapping. */
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
