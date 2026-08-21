import { describe, expect, it } from "vitest";
import {
  cacheSavingsUsd,
  lookupRate,
  normalizeModelName,
  parseRateTable,
  priceTokens,
} from "./usage-pricing.js";
import type { UsageTokens } from "./usage-transcripts.js";

// The standard Anthropic ratio set: $10/M in, $50/M out, 0.1x cache read,
// 1.25x cache write.
const LITELLM_DOC = {
  "claude-fable-5": {
    input_cost_per_token: 1e-5,
    output_cost_per_token: 5e-5,
    cache_read_input_token_cost: 1e-6,
    cache_creation_input_token_cost: 1.25e-5,
  },
  "anthropic/claude-opus-5": {
    input_cost_per_token: 1.5e-5,
    output_cost_per_token: 7.5e-5,
  },
  "half-priced-model": { input_cost_per_token: 1e-6 },
};

const tokens = (overrides: Partial<UsageTokens> = {}): UsageTokens => ({
  inputTokens: 1000,
  cachedInputTokens: 10000,
  cacheCreationTokens: 2000,
  outputTokens: 500,
  reasoningTokens: 100,
  ...overrides,
});

describe("parseRateTable", () => {
  it("projects the four LiteLLM fields and normalizes names", () => {
    const table = parseRateTable(LITELLM_DOC);
    expect(table.get("claude-fable-5")).toEqual({
      inputCostPerToken: 1e-5,
      outputCostPerToken: 5e-5,
      cacheReadCostPerToken: 1e-6,
      cacheCreationCostPerToken: 1.25e-5,
    });
    // Provider prefix stripped; missing cache rates fall back to the
    // input rate (cached input priced as plain input, never free).
    expect(table.get("claude-opus-5")).toMatchObject({
      cacheReadCostPerToken: 1.5e-5,
      cacheCreationCostPerToken: 1.5e-5,
    });
  });

  it("drops entries missing an input or output rate", () => {
    const table = parseRateTable(LITELLM_DOC);
    expect(table.has("half-priced-model")).toBe(false);
  });
});

describe("lookupRate", () => {
  const table = parseRateTable(LITELLM_DOC);
  it("refuses synthetic and bare family names", () => {
    expect(lookupRate(table, "<synthetic>")).toBeNull();
    expect(lookupRate(table, "opus")).toBeNull();
    expect(lookupRate(table, "unknown-model")).toBeNull();
  });
  it("matches case-insensitively and through provider prefixes", () => {
    expect(lookupRate(table, "Anthropic/Claude-Fable-5")).not.toBeNull();
    expect(normalizeModelName("openrouter/anthropic/claude-fable-5")).toBe(
      "claude-fable-5",
    );
  });
});

describe("priceTokens", () => {
  const table = parseRateTable(LITELLM_DOC);
  it("prices each token class at its own rate, reasoning never separately", () => {
    const cost = priceTokens(table, "claude-fable-5", tokens());
    expect(cost).toBeCloseTo(
      1000 * 1e-5 + 10000 * 1e-6 + 2000 * 1.25e-5 + 500 * 5e-5,
      12,
    );
  });
  it("returns null for unpriceable models", () => {
    expect(priceTokens(table, "unknown-model", tokens())).toBeNull();
  });
});

describe("cacheSavingsUsd", () => {
  const table = parseRateTable(LITELLM_DOC);
  it("is cache reads times the input-to-cache-read rate spread", () => {
    expect(cacheSavingsUsd(table, "claude-fable-5", tokens())).toBeCloseTo(
      10000 * (1e-5 - 1e-6),
      12,
    );
  });
  it("is zero when the model is unpriceable", () => {
    expect(cacheSavingsUsd(table, "opus", tokens())).toBe(0);
  });
});
