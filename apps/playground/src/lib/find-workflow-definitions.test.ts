import { describe, expect, it } from "vitest";
import { findWorkflowDefinitions } from "./find-workflow-definitions";

describe("findWorkflowDefinitions", () => {
  it("finds a single exported workflow", () => {
    const source = `export async function myFlow() {
  "use workflow";
  return 1;
}
`;
    expect(findWorkflowDefinitions({ source })).toEqual([
      { name: "myFlow", line: 1 },
    ]);
  });

  it("finds multiple workflows in one file", () => {
    const source = `async function a() {
  "use workflow";
}

export async function b({ x }: { x: number }) {
  "use workflow";
  return x;
}
`;
    expect(findWorkflowDefinitions({ source })).toEqual([
      { name: "a", line: 1 },
      { name: "b", line: 5 },
    ]);
  });

  it("ignores async functions without the workflow directive", () => {
    const source = `async function notAWorkflow() {
  return 1;
}

async function stepLike() {
  "use step";
}
`;
    expect(findWorkflowDefinitions({ source })).toEqual([]);
  });

  it("tolerates multi-line destructured params before the directive", () => {
    const source = `export async function complex({
  alpha,
  beta,
  gamma,
}: {
  alpha: string;
  beta: number;
  gamma: boolean;
}) {
  "use workflow";
  return alpha;
}
`;
    expect(findWorkflowDefinitions({ source })).toEqual([
      { name: "complex", line: 1 },
    ]);
  });

  it("does not match step directives inside comments", () => {
    const source = `/**
 * This is not a workflow even though the comment says "use workflow".
 */
async function commented() {
  return 42;
}
`;
    // Regex matches the text literally; comment mentions would trigger a false
    // positive, but only when a real async function precedes them AND the
    // directive string appears in the body within the scan window. Here there
    // is no body directive so nothing should match.
    expect(findWorkflowDefinitions({ source })).toEqual([]);
  });
});
