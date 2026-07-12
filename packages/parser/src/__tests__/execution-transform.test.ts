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
});
