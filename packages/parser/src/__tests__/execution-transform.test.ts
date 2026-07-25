import { describe, expect, it } from "vitest";
import { prepareWorkflowExecution } from "../execution-transform.js";

const STEPS = `
async function double({ value }: { value: number }) {
  "use step";
  return value * 2;
}

async function stringify({ value }: { value: number }) {
  "use step";
  return String(value);
}
`;

describe("prepareWorkflowExecution", () => {
  it("wraps step call sites with graph node ids", () => {
    const prepared = prepareWorkflowExecution({
      workflowName: "example",
      files: {
        "src/workflow.ts": `${STEPS}
export async function example({ value }: { value: number }) {
  "use workflow";
  const doubled = await double({ value });
  const output = await stringify({ value: doubled });
  return output;
}
`,
      },
    });
    expect(prepared).not.toBeNull();
    const steps = prepared?.graph.nodes.filter((node) => node.type === "step");
    expect(steps).toHaveLength(2);
    const source = prepared?.files["src/workflow.ts"] ?? "";
    for (const step of steps ?? []) {
      expect(source).toContain(
        `globalThis.__catamorphicRunStep("${step.id}", "${step.label}"`,
      );
    }
    expect(source).toContain(
      "(__catamorphicInput) => double(__catamorphicInput)",
    );
  });

  it("assigns distinct ids to repeated and parallel calls", () => {
    const prepared = prepareWorkflowExecution({
      workflowName: "example",
      files: {
        "src/workflow.ts": `${STEPS}
export async function example({ value }: { value: number }) {
  "use workflow";
  const [left, right] = await Promise.all([
    double({ value }),
    double({ value: value + 1 }),
  ]);
  return { left, right };
}
`,
      },
    });
    const steps = prepared?.graph.nodes.filter((node) => node.type === "step");
    expect(steps).toHaveLength(2);
    expect(new Set(steps?.map((step) => step.id)).size).toBe(2);
    const source = prepared?.files["src/workflow.ts"] ?? "";
    for (const step of steps ?? []) {
      expect(source).toContain(`__catamorphicRunStep("${step.id}"`);
    }
  });

  it("does not rewrite step declarations", () => {
    const prepared = prepareWorkflowExecution({
      workflowName: "example",
      files: {
        "src/workflow.ts": `${STEPS}
export async function example({ value }: { value: number }) {
  "use workflow";
  return double({ value });
}
`,
      },
    });
    const source = prepared?.files["src/workflow.ts"] ?? "";
    expect(source).toContain("async function double");
    expect(source).not.toContain("__catamorphic_step_double");
  });

  it("instruments only batch process calls with stable ids", () => {
    const files = {
      "src/batch.ts": `${STEPS}
export const exampleBatch = defineWorkflow(({ defineBoundary, defineBatch }) => ({
  steps: [
    defineBoundary({
      run: async ({ input }) => double({ value: input.value }),
    }),
    defineBatch({
      source: ({ input }) => loadItems({ cursor: input.cursor }),
      process: async ({ item }) => {
        const doubled = await double({ value: item.value });
        if (doubled > 10) {
          await stringify({ value: doubled });
        }
        for (const extra of item.extras) {
          await double({ value: extra });
        }
        return doubled;
      },
      sink: saveItems({ format: "json" }),
    }),
  ],
}));
`,
    };

    const first = prepareWorkflowExecution({
      workflowName: "exampleBatch",
      files,
    });
    const second = prepareWorkflowExecution({
      workflowName: "exampleBatch",
      files,
    });

    expect(first?.graph.capabilities).toMatchObject({
      persistedContinuations: true,
      batchProcessing: true,
    });
    const firstSteps =
      first?.graph.nodes.filter((node) => node.type === "step") ?? [];
    const secondSteps =
      second?.graph.nodes.filter((node) => node.type === "step") ?? [];
    expect(firstSteps).toHaveLength(4);
    expect(firstSteps.map((node) => node.id)).toEqual(
      secondSteps.map((node) => node.id),
    );

    const transformed = first?.files["src/batch.ts"] ?? "";
    const batch = first?.graph.nodes.find((node) => node.type === "batch");
    const processSteps = firstSteps.filter(
      (step) => step.parentId === batch?.id,
    );
    for (const step of processSteps) {
      expect(transformed).toContain(`__catamorphicRunStep("${step.id}"`);
    }
    const boundaryStep = firstSteps.find((step) => step.parentId !== batch?.id);
    expect(transformed).not.toContain(
      `__catamorphicRunStep("${boundaryStep?.id}"`,
    );
    expect(transformed).toContain(
      "source: ({ input }) => loadItems({ cursor: input.cursor })",
    );
    expect(transformed).toContain('sink: saveItems({ format: "json" })');
    expect(transformed).not.toContain(
      "__catamorphicInput) => loadItems(__catamorphicInput)",
    );
    expect(transformed).not.toContain(
      "__catamorphicInput) => saveItems(__catamorphicInput)",
    );
    expect(transformed.match(/__catamorphicRunStep/g)).toHaveLength(3);
  });

  it("preserves durable definitions while collecting runtime metadata", () => {
    const files = {
      "src/durable.ts": `
export const durable = defineWorkflow(({ defineBoundary }) => ({
  steps: [
    defineBoundary({
      run: async ({ input, pause }: BoundaryContext<{ value: number }>) => {
        const doubled = await double({ value: input.value });
        return pause({ state: doubled });
      },
    }),
  ],
}));
${STEPS}
`,
    };

    const prepared = prepareWorkflowExecution({
      workflowName: "durable",
      files,
    });

    expect(prepared?.graph.capabilities.persistedContinuations).toBe(true);
    expect(prepared?.files).toEqual(files);
    expect(prepared?.files["src/durable.ts"]).not.toContain(
      "__catamorphicRunStep",
    );
  });

  it("instruments physical batch-step calls inside process", () => {
    const prepared = prepareWorkflowExecution({
      workflowName: "batchFlow",
      files: {
        "src/batch.ts": `
export const classify = defineBatchStep({
  batch: { maxItems: 10, maxWaitMs: 25 },
  run: async ({ items }) => items,
});
export const batchFlow = defineWorkflow(({ defineBatch }) => ({
  steps: [
    defineBatch({
      source: ({ input }) => loadItems({ input }),
      process: async ({ item }) => {
        return classify({ value: item.value });
      },
      sink: saveItems({ format: "json" }),
    }),
  ],
}));
`,
      },
    });

    const physicalStep = prepared?.graph.execution.steps.flatMap((step) =>
      step.type === "batch" ? step.process.physicalSteps : [],
    )[0];
    expect(physicalStep?.functionName).toBe("classify");
    const transformed = prepared?.files["src/batch.ts"] ?? "";
    expect(transformed).toContain(
      `__catamorphicRunStep("${physicalStep?.nodeId}", "classify"`,
    );
    expect(transformed).toContain(
      "source: ({ input }) => loadItems({ input })",
    );
    expect(transformed).toContain('sink: saveItems({ format: "json" })');
  });

  it("passes child capabilities and execution metadata to callWorkflow", () => {
    const prepared = prepareWorkflowExecution({
      workflowName: "parent",
      files: {
        "src/parent.ts": `
export const parent = defineWorkflow(({ defineBoundary }) => ({
  steps: [
    defineBoundary({
      run: ({ input, callWorkflow }) => callWorkflow(child, { input }),
    }),
  ],
}));
`,
        "src/child.ts": `
export async function child({ value }: { value: string }) {
  "use workflow";
  return finish({ value });
}
`,
      },
    });
    const transformed = prepared?.files["src/parent.ts"] ?? "";

    expect(transformed).toContain('"modulePath":"src/child.ts"');
    expect(transformed).toContain('"exportName":"child"');
    expect(transformed).toContain(
      '"capabilities":{"persistedContinuations":false,"batchProcessing":false,"cancellation":false}',
    );
    expect(transformed).toContain(
      '"execution":{"exportTarget":{"modulePath":"src/child.ts","exportName":"child"},"steps":[]}',
    );
  });

  it("prepares the complete project identically for parent and child targets", () => {
    const files = {
      "src/parent.ts": `
import { definedChild } from "./defined-child.js";

export const parent = defineWorkflow(({ defineBoundary }) => ({
  steps: [
    defineBoundary({
      run: ({ input, callWorkflow }) => callWorkflow(definedChild, { input }),
    }),
  ],
}));
`,
      "src/defined-child.ts": `
import { plainChild } from "./plain-child.js";

export const definedChild = defineWorkflow(({ defineBoundary, defineBatch }) => ({
  steps: [
    defineBatch({
      source: ({ input }) => loadItems({ input }),
      process: async ({ item }) => processItem({ item }),
    }),
    defineBoundary({
      run: ({ input, callWorkflow }) => callWorkflow(plainChild, { input }),
    }),
  ],
}));
`,
      "src/plain-child.ts": `
export async function plainChild({ value }: { value: string }) {
  "use workflow";
  return finish({ value });
}
`,
    };

    const parent = prepareWorkflowExecution({ files, workflowName: "parent" });
    const definedChild = prepareWorkflowExecution({
      files,
      workflowName: "definedChild",
    });
    const plainChild = prepareWorkflowExecution({
      files,
      workflowName: "plainChild",
    });

    expect(parent?.files).toEqual(definedChild?.files);
    expect(parent?.files).toEqual(plainChild?.files);
    expect(parent?.graph.name).toBe("parent");
    expect(definedChild?.graph.name).toBe("definedChild");
    expect(plainChild?.graph.name).toBe("plainChild");
    expect(parent?.files["src/parent.ts"]).toContain(
      '"modulePath":"src/defined-child.ts"',
    );
    expect(parent?.files["src/defined-child.ts"]).toContain(
      '"modulePath":"src/plain-child.ts"',
    );
    const batchStep = definedChild?.graph.nodes.find(
      (node) => node.type === "step" && node.functionName === "processItem",
    );
    const plainStep = plainChild?.graph.nodes.find(
      (node) => node.type === "step" && node.functionName === "finish",
    );
    expect(parent?.files["src/defined-child.ts"]).toContain(
      `__catamorphicRunStep("${batchStep?.id}"`,
    );
    expect(parent?.files["src/plain-child.ts"]).toContain(
      `__catamorphicRunStep("${plainStep?.id}"`,
    );
  });
});
