import { describe, expect, it } from "vitest";
import {
  type BatchConsistency,
  batchFailed,
  batchSkipped,
  batchSucceeded,
  defineBatchStep,
  defineWorkflow,
  skipBatchItem,
  validateKeyedBatchOutcomes,
} from "../index.js";

describe("batch contracts", () => {
  it("constructs a batch workflow step with structural runtime fields", async () => {
    const consistency: BatchConsistency = "snapshot";
    const workflow = defineWorkflow(({ defineBatch }) => ({
      steps: [
        defineBatch({
          failurePolicy: { mode: "continue", maxFailures: 5 },
          source: async ({ input }: { input: { pageSize: number } }) => ({
            config: { pageSize: input.pageSize },
            source: {
              consistency,
              initialize: async () => ({ snapshot: { highWaterMark: 10 } }),
              readPage: async () => ({ items: [], done: true }),
            },
          }),
          process: async ({ item }: { item: number }) => item * 2,
        }),
      ],
    }));

    expect(workflow.steps).toHaveLength(1);
    expect(Object.keys(workflow.steps[0] ?? {})).not.toContain("kind");
    expect(workflow.steps[0]?.failurePolicy).toEqual({
      mode: "continue",
      maxFailures: 5,
    });
    await expect(
      workflow.steps[0]?.process({
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

  it("validates batch failure policies", () => {
    const defineInvalidBatch = (failurePolicy: unknown) =>
      defineWorkflow(({ defineBatch }) => ({
        steps: [
          Reflect.apply(defineBatch, undefined, [
            {
              failurePolicy,
              source: async ({ input }: { input: { pageSize: number } }) => ({
                config: input,
                source: {
                  consistency: "snapshot",
                  initialize: async () => ({ snapshot: { at: "now" } }),
                  readPage: async () => ({ items: [], done: true }),
                },
              }),
              process: async ({ item }: { item: number }) => item,
            },
          ]),
        ],
      }));

    expect(() => defineInvalidBatch("continue")).toThrow("must be an object");
    expect(() => defineInvalidBatch({ mode: "stop" })).toThrow("mode");
    expect(() =>
      defineInvalidBatch({ mode: "continue", maxFailures: 0 }),
    ).toThrow("positive integer");
    expect(() =>
      defineInvalidBatch({ mode: "continue", maxFailures: 1.5 }),
    ).toThrow("positive integer");
    expect(() =>
      defineInvalidBatch({ mode: "fail_fast", unexpected: true }),
    ).toThrow("only mode and maxFailures");
  });

  it("validates physical batch step bounds", () => {
    const validStep = defineBatchStep({
      batch: { maxItems: 1, maxWaitMs: 0 },
      run: async () => [],
    });
    expect(Object.keys(validStep)).not.toContain("kind");
    expect(Reflect.get(validStep, "kind")).toBe("batch-step");

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
