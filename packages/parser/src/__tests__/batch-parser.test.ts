import { describe, expect, it } from "vitest";
import { layoutGraph, parseProject, parseWorkflow } from "../index.js";

const MIXED_SOURCE = `
export const classify = defineBatchStep({
  batch: {
    maxItems: 100,
    maxWaitMs: 2000,
    maxBytes: 1000000,
    rateLimits: [{ globalKey: "classify", capacity: 100, refillRatePerSecond: 10 }],
  },
  partitionBy: ({ locale }) => locale,
  async run({ items }) {
    return items;
  },
});

export const analyzeFeedback = defineWorkflow(({ defineBoundary, defineBatch }) => ({
  controls: { cancel: true },
  steps: [
    defineBoundary({
      retry: { maxAttempts: 3, backoff: { initial: "1s" } },
      run: async ({ input }) => normalizeInput({ input }),
    }),
    /** @displayname Analyze Feedback */
    defineBatch({
      failurePolicy: { mode: "continue", maxFailures: 2_500 },
      source: ({ input }) => feedbackSource({ after: input.createdAfter }),
      process: async ({ item }) => {
        const normalized = await normalize({ value: item.value });
        const result = await classify({ text: normalized, locale: item.locale });
        if (normalized.length > 0) {
          await publish({ value: normalized });
        }
        return result;
      },
      sink: csvSink({ fileName: "feedback.csv" }),
    }),
    defineBoundary({
      run: async ({ input }) => publishSummary({ input }),
    }),
  ],
}));
`;

describe("batch scope parsing", () => {
  it("discovers exported plain and defined workflows without kind fields", () => {
    const result = parseProject({
      "src/analyze-feedback.ts": MIXED_SOURCE,
      "src/plain.ts": `
export async function plain() {
  "use workflow";
  await publish({ value: "ok" });
}
async function privateFlow() {
  "use workflow";
}
export function notAsync() {
  "use workflow";
}
export async function singleQuoted() {
  'use workflow';
}
export async function misleadingDirective() {
  "use workflow later";
}
`,
    });

    expect(result.errors).toEqual([]);
    expect(result.workflows.map((workflow) => workflow.functionName)).toEqual([
      "analyzeFeedback",
      "plain",
      "singleQuoted",
    ]);
    expect(result.workflows[0]).not.toHaveProperty("kind");
    expect(result.workflows[0]?.graph).not.toHaveProperty("kind");
    expect(result.workflows[0]?.capabilities).toEqual({
      persistedContinuations: true,
      batchProcessing: true,
      cancellation: true,
    });
    expect(result.workflows[1]?.capabilities).toEqual({
      persistedContinuations: false,
      batchProcessing: false,
      cancellation: false,
    });
    expect(result.workflows[2]?.capabilities).toEqual(
      result.workflows[1]?.capabilities,
    );
  });

  it("renders an ordered batch container with source, process, and sink", () => {
    const graph = parseWorkflow(MIXED_SOURCE);
    const topLevel = graph.nodes.filter(
      (node) => node.type === "durable-boundary" || node.type === "batch",
    );
    const batch = topLevel.find((node) => node.type === "batch");
    if (!batch) throw new Error("Expected batch container");

    expect(topLevel.map((node) => node.type)).toEqual([
      "durable-boundary",
      "batch",
      "durable-boundary",
    ]);
    expect(batch.label).toBe("Analyze Feedback");
    expect(
      graph.nodes
        .filter((node) => node.parentId === batch.id)
        .map((node) => node.type),
    ).toEqual(
      expect.arrayContaining(["source", "step", "if-block", "return", "sink"]),
    );
    expect(graph.nodes.map((node) => String(node.type))).not.toContain("stage");
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: topLevel[0]?.id,
          target: batch.id,
        }),
        expect.objectContaining({
          source: batch.id,
          target: topLevel[2]?.id,
        }),
      ]),
    );

    const layout = layoutGraph({ nodes: graph.nodes, edges: graph.edges });
    expect(
      layout.nodes.find((node) => node.id === batch.id)?.height,
    ).toBeGreaterThan(100);
  });

  it("emits typed ordered descriptors and physical batch policy", () => {
    const graph = parseWorkflow(MIXED_SOURCE);

    expect(graph.execution.exportTarget).toEqual({
      modulePath: "workflow.ts",
      exportName: "analyzeFeedback",
    });
    expect(graph.execution.steps.map((step) => step.type)).toEqual([
      "boundary",
      "batch",
      "boundary",
    ]);
    expect(graph.execution.steps.map((step) => step.topLevelIndex)).toEqual([
      0, 1, 2,
    ]);
    expect(graph.execution.steps[0]).toMatchObject({
      type: "boundary",
      retry: {
        maxAttemptsExpression: "3",
        backoff: { initialExpression: '"1s"' },
      },
    });
    expect(graph.execution.steps[1]).toMatchObject({
      type: "batch",
      failurePolicy: { mode: "continue", maxFailures: 2500 },
      source: { sourceRange: expect.any(Object) },
      process: {
        sourceRange: expect.any(Object),
        stepNodeIds: expect.any(Array),
        physicalSteps: [
          {
            functionName: "classify",
            policy: {
              maxItemsExpression: "100",
              maxWaitMsExpression: "2000",
              maxBytesExpression: "1000000",
              rateLimitsExpression: expect.stringContaining("globalKey"),
              partitionByExpression: expect.stringContaining("locale"),
            },
            exportTarget: {
              modulePath: "workflow.ts",
              exportName: "classify",
            },
          },
        ],
      },
      sink: { sourceRange: expect.any(Object) },
    });
  });

  it("allows a batch without a sink", () => {
    const graph = parseWorkflow(`
export const collect = defineWorkflow(({ defineBatch }) => ({
  steps: [
    defineBatch({
      source: ({ input }) => input.source,
      process: async ({ item }) => {
        await collectItem({ item });
      },
    }),
  ],
}));
`);
    const batch = graph.nodes.find((node) => node.type === "batch");
    expect(batch).toBeDefined();
    expect(graph.nodes.some((node) => node.type === "sink")).toBe(false);
    expect(graph.execution.steps[0]).not.toHaveProperty("sink");
    expect(graph.execution.steps[0]).toMatchObject({
      failurePolicy: { mode: "continue" },
    });
  });

  it("validates authored failure policy literals", () => {
    const source = (failurePolicy: string) => `
export const invalid = defineWorkflow(({ defineBatch }) => ({
  steps: [
    defineBatch({
      failurePolicy: ${failurePolicy},
      source: ({ input }) => input.source,
      process: async ({ item }) => item,
    }),
  ],
}));
`;
    expect(() => parseWorkflow(source('{ mode: "stop" }'))).toThrow(
      "must be 'continue' or 'fail_fast'",
    );
    expect(() =>
      parseWorkflow(source('{ mode: "continue", maxFailures: 0 }')),
    ).toThrow("must be a positive integer literal");
  });

  it("parses an expression-bodied process", () => {
    const graph = parseWorkflow(`
export const collect = defineWorkflow(({ defineBatch }) => ({
  steps: [
    defineBatch({
      source: ({ input }) => input.source,
      process: async ({ item }) => collectItem({ item }),
    }),
  ],
}));
`);
    const batch = graph.nodes.find((node) => node.type === "batch");
    expect(
      graph.nodes.find(
        (node) =>
          node.functionName === "collectItem" && node.parentId === batch?.id,
      ),
    ).toBeDefined();
    expect(
      graph.nodes.find(
        (node) => node.type === "return" && node.parentId === batch?.id,
      )?.returnExpression,
    ).toBe("collectItem({ item })");
  });

  it("rejects obsolete defineBatchWorkflow with a migration diagnostic", () => {
    const source = `
export const oldBatch = defineBatchWorkflow({
  source: ({ input }) => input.items,
  process: async ({ item }) => item,
});
`;
    const result = parseProject({ "src/old.ts": source });
    expect(result.workflows).toEqual([]);
    expect(result.errors[0]?.message).toContain(
      "uses removed defineBatchWorkflow",
    );
    expect(result.errors[0]?.message).toContain("defineBatch(...)");
    expect(() => parseWorkflow(source)).toThrow(
      "uses removed defineBatchWorkflow",
    );
  });

  it("rejects batch-step calls outside defineBatch.process", () => {
    expect(() =>
      parseWorkflow(`
export const classify = defineBatchStep({
  batch: { maxItems: 10, maxWaitMs: 10 },
  run: async ({ items }) => items,
});
export const invalid = defineWorkflow(({ defineBoundary }) => ({
  steps: [
    defineBoundary({ run: async ({ input }) => classify({ input }) }),
  ],
}));
`),
    ).toThrow("may only be called inside defineBatch.process");
  });

  it("rejects non-exported physical batch steps", () => {
    expect(() =>
      parseWorkflow(`
const classify = defineBatchStep({
  batch: { maxItems: 10, maxWaitMs: 10 },
  run: async ({ items }) => items,
});
export const invalid = defineWorkflow(({ defineBatch }) => ({
  steps: [
    defineBatch({
      source: ({ input }) => input.source,
      process: async ({ item }) => {
        return classify({ item });
      },
    }),
  ],
}));
`),
    ).toThrow("must be exported");
  });

  it("reports malformed batch scope callbacks", () => {
    const source = `
export const invalid = defineWorkflow(({ defineBatch }) => ({
  steps: [
    defineBatch({ source: makeSource(), process: processItem }),
  ],
}));
`;
    const result = parseProject({ "src/invalid.ts": source });
    expect(result.workflows).toEqual([]);
    expect(result.errors[0]?.message).toContain(
      "must define 'process' as an inline function",
    );
  });
});
