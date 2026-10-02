import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentTurnUsage } from "@catamorphic/agent-protocol";
import { positiveTokenCount } from "@catamorphic/sandbox";

function count(record: unknown, key: string): number {
  return record && typeof record === "object" && key in record
    ? positiveTokenCount(Reflect.get(record, key))
    : 0;
}

/**
 * One turn's usage from the SDK result (ADR 0057). Totals and cost come
 * from the result; the dominant `modelUsage` entry names the model and its
 * context window; context occupancy is the input side of the last
 * main-thread assistant usage (its final iteration when there are several),
 * since the result only totals the turn.
 */
export function turnUsageFromResult(input: {
  result: SDKResultMessage;
  lastMainUsage: unknown;
}): AgentTurnUsage | undefined {
  const { result } = input;
  let model: string | undefined;
  let contextWindow: number | undefined;
  let dominant = -1;
  for (const [name, entry] of Object.entries(result.modelUsage ?? {})) {
    const tokens =
      count(entry, "inputTokens") +
      count(entry, "cacheReadInputTokens") +
      count(entry, "outputTokens");
    if (tokens > dominant) {
      dominant = tokens;
      model = name;
      const window = count(entry, "contextWindow");
      contextWindow = window > 0 ? window : undefined;
    }
  }

  let contextTokens: number | undefined;
  const last = input.lastMainUsage;
  if (last && typeof last === "object") {
    const iterations: unknown = Reflect.get(last, "iterations");
    const current =
      Array.isArray(iterations) && iterations.length > 0
        ? iterations[iterations.length - 1]
        : last;
    const occupancy =
      count(current, "input_tokens") +
      count(current, "cache_read_input_tokens") +
      count(current, "cache_creation_input_tokens");
    contextTokens = occupancy > 0 ? occupancy : undefined;
  }

  const costUsd = result.total_cost_usd;
  const usage: AgentTurnUsage = {
    ...(model ? { model } : {}),
    inputTokens: count(result.usage, "input_tokens"),
    cachedInputTokens: count(result.usage, "cache_read_input_tokens"),
    cacheCreationTokens: count(result.usage, "cache_creation_input_tokens"),
    outputTokens: count(result.usage, "output_tokens"),
    ...(Number.isFinite(costUsd) && costUsd > 0 ? { costUsd } : {}),
    ...(contextTokens ? { contextTokens } : {}),
    ...(contextWindow ? { contextWindow } : {}),
  };
  const tokens =
    (usage.inputTokens ?? 0) +
    (usage.cachedInputTokens ?? 0) +
    (usage.cacheCreationTokens ?? 0) +
    (usage.outputTokens ?? 0);
  return tokens > 0 || usage.costUsd || contextTokens ? usage : undefined;
}
