import { describe, expect, it } from "vitest";
import {
  parseProject,
  parseWorkflow,
  parseWorkflowFromProject,
  type WorkflowKind,
} from "../index.js";

const BATCH_SOURCE = `
async function normalize({ value }: { value: string }) {
  "use step";
  return value.trim();
}

async function publish({ value }: { value: string }) {
  "use step";
}

export const analyzeFeedback = defineBatchWorkflow({
  source: ({ input }) => feedbackSource({ after: input.createdAfter }),
  process: async ({ item }) => {
    const normalized = await normalize({ value: item.value });
    if (normalized.length > 0) {
      await publish({ value: normalized });
    }
    for (const tag of item.tags) {
      await publish({ value: tag });
    }
    return normalized;
  },
  sink: csvSink({ fileName: "feedback.csv" }),
});
`;

describe("batch workflow parsing", () => {
  it("exports both workflow kinds", () => {
    const kinds: WorkflowKind[] = ["regular", "batch"];
    expect(kinds).toEqual(["regular", "batch"]);
  });

  it("discovers exported defineBatchWorkflow variables by identifier name", () => {
    const result = parseProject({
      "src/analyze-feedback.ts": BATCH_SOURCE,
      "src/ignored.ts": `
const privateBatch = defineBatchWorkflow({
  source: ({ input }) => input.items,
  process: async ({ item }) => { return item; },
});
export const qualified = workflows.defineBatchWorkflow({
  source: ({ input }) => input.items,
  process: async ({ item }) => { return item; },
});
`,
    });

    expect(result.errors).toEqual([]);
    expect(result.workflows).toHaveLength(1);
    expect(result.workflows[0]?.functionName).toBe("analyzeFeedback");
    expect(result.workflows[0]?.kind).toBe("batch");
    expect(result.workflows[0]?.graph.kind).toBe("batch");
    expect(result.workflows[0]?.graph.name).toBe("analyzeFeedback");
  });

  it("parses source, process control flow, and sink into one graph", () => {
    const graph = parseWorkflow(BATCH_SOURCE);

    expect(graph.kind).toBe("batch");
    expect(graph.nodes.some((node) => node.type === "trigger")).toBe(false);

    const source = graph.nodes.find((node) => node.type === "source");
    const sink = graph.nodes.find((node) => node.type === "sink");
    expect(source).toBeDefined();
    expect(sink).toBeDefined();
    if (!source || !sink) {
      throw new Error("Expected source and sink nodes");
    }
    expect(source.parameters?.map((parameter) => parameter.name)).toEqual([
      "input",
    ]);
    expect(
      BATCH_SOURCE.slice(source.sourceRange.start, source.sourceRange.end),
    ).toBe("({ input }) => feedbackSource({ after: input.createdAfter })");
    expect(
      BATCH_SOURCE.slice(sink.sourceRange.start, sink.sourceRange.end),
    ).toBe('csvSink({ fileName: "feedback.csv" })');

    expect(
      graph.nodes.filter((node) => node.functionName === "publish"),
    ).toHaveLength(2);
    expect(graph.nodes.some((node) => node.type === "if-block")).toBe(true);
    expect(graph.nodes.some((node) => node.type === "loop-block")).toBe(true);
    expect(graph.nodes.find((node) => node.type === "return")?.label).toBe(
      "Item result",
    );

    const sourceEdge = graph.edges.find((edge) => edge.source === source.id);
    const sinkEdge = graph.edges.find((edge) => edge.target === sink.id);
    expect(sourceEdge).toBeDefined();
    expect(sinkEdge).toBeDefined();
  });

  it("supports batch workflows without a sink", () => {
    const graph = parseWorkflow(`
export const collectItems = defineBatchWorkflow({
  source: ({ input }) => input.items,
  process: async ({ item }) => {
    await collect({ item });
  },
});
`);

    expect(graph.kind).toBe("batch");
    expect(graph.nodes.map((node) => node.type)).toEqual(["source", "step"]);
  });

  it("marks exported batch steps with statically inspected policy", () => {
    const graph = parseWorkflow(`
/** @displayname Classify Feedback */
export const classify = defineBatchStep({
  batch: { maxItems: 100, maxWaitMs: 2000, maxBytes: 1000000 },
  async run({ items }) {
    return items;
  },
});
export const analyze = defineBatchWorkflow({
  source: ({ input }) => input.items,
  process: async ({ item }) => {
    return classify({ text: item.text });
  },
});
`);
    const step = graph.nodes.find((node) => node.functionName === "classify");
    expect(step?.label).toBe("Classify Feedback");
    expect(step?.metadata).toMatchObject({
      batchStep: "true",
      batchStepExported: "true",
      "batch:maxItems": "100",
      "batch:maxWaitMs": "2000",
      "batch:maxBytes": "1000000",
    });
  });

  it("rejects non-exported batch steps because workers cannot target them", () => {
    const source = `
const classify = defineBatchStep({
  batch: { maxItems: 10, maxWaitMs: 10 },
  run: async ({ items }) => items,
});
export const analyze = defineBatchWorkflow({
  source: ({ input }) => input.items,
  process: async ({ item }) => {
    const result = await classify({ text: item.text });
    return result;
  },
});
`;
    expect(() => parseWorkflow(source)).toThrow("must be exported");
  });

  it("inspects callbacks without executing user code", () => {
    const graph = parseWorkflow(`
export const staticOnly = defineBatchWorkflow({
  source: ({ input }) => {
    throw new Error(input.message);
  },
  process: async ({ item }) => {
    throw new Error(item.message);
  },
  sink: (() => { throw new Error("sink"); })(),
});
`);

    expect(graph.kind).toBe("batch");
    expect(graph.nodes.map((node) => node.type)).toEqual(["source", "sink"]);
  });

  it("resolves a named batch workflow from a project", () => {
    const graph = parseWorkflowFromProject(
      { "src/analyze-feedback.ts": BATCH_SOURCE },
      "analyzeFeedback",
    );

    expect(graph?.kind).toBe("batch");
    expect(graph?.name).toBe("analyzeFeedback");
  });

  it.each([
    {
      name: "missing source",
      source: `
export const invalid = defineBatchWorkflow({
  process: async ({ item }) => { return item; },
});
`,
      message: "missing required 'source'",
    },
    {
      name: "non-callback source",
      source: `
export const invalid = defineBatchWorkflow({
  source: createSource(),
  process: async ({ item }) => { return item; },
});
`,
      message: "'source' must be an inline function",
    },
    {
      name: "missing process",
      source: `
export const invalid = defineBatchWorkflow({
  source: ({ input }) => input.items,
});
`,
      message: "missing required 'process'",
    },
    {
      name: "non-callback process",
      source: `
export const invalid = defineBatchWorkflow({
  source: ({ input }) => input.items,
  process: processItem,
});
`,
      message: "'process' must be an inline function",
    },
    {
      name: "expression-bodied process",
      source: `
export const invalid = defineBatchWorkflow({
  source: ({ input }) => input.items,
  process: async ({ item }) => item,
});
`,
      message: "'process' must have a block body",
    },
  ])("reports $name", ({ source, message }) => {
    const result = parseProject({ "src/invalid.ts": source });

    expect(result.workflows).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain(message);
    expect(() => parseWorkflow(source)).toThrow(message);
  });

  it("keeps regular workflow discovery explicit and unchanged", () => {
    const result = parseProject({
      "src/regular.ts": `
export async function regularWorkflow({ value }: { value: string }) {
  "use workflow";
  await regularStep({ value });
  return value;
}
`,
    });

    expect(result.errors).toEqual([]);
    expect(result.workflows[0]?.kind).toBe("regular");
    expect(result.workflows[0]?.graph.kind).toBe("regular");
    expect(result.workflows[0]?.graph.nodes.map((node) => node.type)).toEqual([
      "trigger",
      "step",
      "return",
    ]);
  });
});
