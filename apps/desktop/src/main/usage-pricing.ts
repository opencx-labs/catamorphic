/**
 * Model pricing for the usage page (ADR 0057). Rates come from LiteLLM's
 * published price table, fetched at most daily by usage-scan.ts and cached
 * on disk; nothing here is checked into the repo, so new models price
 * themselves. This module is the pure part: parsing the table and the
 * cost arithmetic.
 *
 * Cost is an API-equivalent estimate. Transcripts do not record serving
 * tier, so everything prices at base tier; unknown models keep their
 * tokens in the totals and price at zero rather than guessing.
 */

import type { UsageTokens } from "./usage-transcripts.js";

export interface ModelRate {
  /** All rates are USD per token. */
  inputCostPerToken: number;
  outputCostPerToken: number;
  cacheReadCostPerToken: number;
  cacheCreationCostPerToken: number;
}

export type RateTable = ReadonlyMap<string, ModelRate>;

/**
 * Models that can never be priced: locally synthesized records and bare
 * family names that are ambiguous across generations. Their tokens still
 * count; their cost reports as unpriced instead of a guess.
 */
const UNPRICEABLE_MODELS = new Set([
  "<synthetic>",
  "synthetic",
  "opus",
  "sonnet",
  "haiku",
  "fable",
]);

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

/**
 * Project the raw LiteLLM document to a rate table. Entries missing both
 * input and output rates are dropped — a half-priced model would silently
 * under-report, which is worse than reporting it unpriced. Missing cache
 * rates fall back to the input rate: cached input priced as plain input,
 * never free.
 */
export function parseRateTable(document: unknown): RateTable {
  const table = new Map<string, ModelRate>();
  if (document === null || typeof document !== "object") return table;
  for (const [name, raw] of Object.entries(
    document as Record<string, unknown>,
  )) {
    if (raw === null || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    const input = finiteNumber(entry.input_cost_per_token);
    const output = finiteNumber(entry.output_cost_per_token);
    if (input === undefined || output === undefined) continue;
    table.set(normalizeModelName(name), {
      inputCostPerToken: input,
      outputCostPerToken: output,
      cacheReadCostPerToken:
        finiteNumber(entry.cache_read_input_token_cost) ?? input,
      cacheCreationCostPerToken:
        finiteNumber(entry.cache_creation_input_token_cost) ?? input,
    });
  }
  return table;
}

/** LiteLLM publishes both `claude-x` and `provider/claude-x`; strip the
 *  prefix and lowercase so transcript names hit either form. */
export function normalizeModelName(model: string): string {
  const trimmed = model.trim().toLowerCase();
  const slash = trimmed.lastIndexOf("/");
  return slash === -1 ? trimmed : trimmed.slice(slash + 1);
}

export function lookupRate(table: RateTable, model: string): ModelRate | null {
  const normalized = normalizeModelName(model);
  if (normalized.length === 0 || UNPRICEABLE_MODELS.has(normalized)) {
    return null;
  }
  return table.get(normalized) ?? null;
}

/** API-equivalent cost of one record's tokens; null when unpriceable.
 *  reasoningTokens is inside outputTokens and is never priced separately. */
export function priceTokens(
  table: RateTable,
  model: string,
  tokens: UsageTokens,
): number | null {
  const rate = lookupRate(table, model);
  if (rate === null) return null;
  return (
    tokens.inputTokens * rate.inputCostPerToken +
    tokens.cachedInputTokens * rate.cacheReadCostPerToken +
    tokens.cacheCreationTokens * rate.cacheCreationCostPerToken +
    tokens.outputTokens * rate.outputCostPerToken
  );
}

/** What the cache-read tokens would have cost at the full input rate,
 *  minus what they actually cost. Gross saving: the cache-write premium
 *  is deliberately not netted against it. */
export function cacheSavingsUsd(
  table: RateTable,
  model: string,
  tokens: UsageTokens,
): number {
  const rate = lookupRate(table, model);
  if (rate === null) return 0;
  return (
    tokens.cachedInputTokens *
    Math.max(0, rate.inputCostPerToken - rate.cacheReadCostPerToken)
  );
}
