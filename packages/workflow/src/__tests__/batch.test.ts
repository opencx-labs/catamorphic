import { describe, expect, it } from "vitest";
import {
  type BatchConsistency,
  batchFailed,
  batchSkipped,
  batchSucceeded,
  defineBatchStep,
  defineBatchWorkflow,
  skipBatchItem,
  validateKeyedBatchOutcomes,
} from "../index.js";

describe("batch workflow contracts", () => {
  it("preserves executable workflow definitions", async () => {
    const consistency: BatchConsistency = "snapshot";
    const definition = defineBatchWorkflow({
      source: async ({ input }: { input: { pageSize: number } }) => ({
        config: { pageSize: input.pageSize },
        source: {
          consistency,
          initialize: async () => ({ snapshot: { highWaterMark: 10 } }),
          readPage: async () => ({ items: [], done: true }),
        },
      }),
      process: async ({ item }: { item: number }) => item * 2,
    });

    expect(definition.kind).toBe("batch-workflow");
    await expect(
      definition.process({
        key: "one",
        item: 2,
        context: {
          invocationId: "invocation-1",
          attempt: 1,
          deadlineAt: new Date(Date.now() + 1_000).toISOString(),
          signal: new AbortController().signal,
        },
      }),
    ).resolves.toBe(4);
  });

  it("validates batch step bounds", () => {
    expect(() =>
      defineBatchStep({
        batch: { maxItems: 0, maxWaitMs: 10 },
        run: async () => [],
      }),
    ).toThrow("maxItems");
    expect(() =>
      defineBatchStep({
        batch: { maxItems: 1, maxWaitMs: -1 },
        run: async () => [],
      }),
    ).toThrow("maxWaitMs");
    expect(() =>
      defineBatchStep({
        batch: { maxItems: 1, maxWaitMs: 0, maxBytes: 0 },
        run: async () => [],
      }),
    ).toThrow("maxBytes");
    expect(() =>
      defineBatchStep({
        batch: {
          maxItems: 1,
          maxWaitMs: 0,
          rateLimits: [
            {
              globalKey: "provider",
              capacity: 1,
              refillRatePerSecond: 0,
            },
          ],
        },
        run: async () => [],
      }),
    ).toThrow("refillRatePerSecond");
  });

  it("constructs and validates keyed outcomes", () => {
    const outcomes = [
      batchSucceeded({ key: "one", result: 1 }),
      batchFailed({
        key: "two",
        error: { message: "retry later", retryable: true },
      }),
      batchSkipped({ key: "three", reason: "filtered" }),
    ];
    expect(
      validateKeyedBatchOutcomes({
        inputKeys: ["one", "two", "three"],
        outcomes,
      }),
    ).toBe(outcomes);
  });

  it("marks item-level skips with a stable runtime error", () => {
    expect(() => skipBatchItem({ reason: "invalid record" })).toThrow(
      expect.objectContaining({
        name: "BatchItemSkippedError",
        message: "invalid record",
      }),
    );
  });

  it("rejects duplicate, missing, and unknown outcome keys", () => {
    expect(() =>
      validateKeyedBatchOutcomes({
        inputKeys: ["one"],
        outcomes: [
          batchSucceeded({ key: "one", result: 1 }),
          batchSucceeded({ key: "one", result: 2 }),
        ],
      }),
    ).toThrow("duplicate");
    expect(() =>
      validateKeyedBatchOutcomes({
        inputKeys: ["one", "two"],
        outcomes: [batchSucceeded({ key: "one", result: 1 })],
      }),
    ).toThrow("omitted");
    expect(() =>
      validateKeyedBatchOutcomes({
        inputKeys: ["one"],
        outcomes: [batchSucceeded({ key: "other", result: 1 })],
      }),
    ).toThrow("unknown");
  });
});
