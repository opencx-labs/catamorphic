import { describe, expect, it } from "vitest";
import { findWorkflowDefinitions } from "./find-workflow-definitions";

describe("findWorkflowDefinitions", () => {
  it("finds a single exported workflow", () => {
    const source = `export const myFlow = defineWorkflow(({ defineBoundary }) => ({
  steps: [
    defineBoundary({ run: () => 1 }),
  ],
}));
`;
    expect(findWorkflowDefinitions({ source })).toEqual([
      { name: "myFlow", line: 1 },
    ]);
  });

  it("finds multiple workflows in one file, exported or not", () => {
    const source = `const a = defineWorkflow(({ defineBoundary }) => ({
  steps: [defineBoundary({ run: () => 1 })],
}));

export const b = defineWorkflow(({ defineBoundary }) => ({
  steps: [defineBoundary({ run: ({ input }: BoundaryContext<{ x: number }>) => input.x })],
}));
`;
    expect(findWorkflowDefinitions({ source })).toEqual([
      { name: "a", line: 1 },
      { name: "b", line: 5 },
    ]);
  });

  it("ignores declarations that are not defineWorkflow calls", () => {
    const source = `const notAWorkflow = defineBoundary({ run: () => 1 });

export const alsoNot = defineSecrets({ API_KEY: {} });

async function helper() {
  return 1;
}
`;
    expect(findWorkflowDefinitions({ source })).toEqual([]);
  });

  it("ignores defineWorkflow mentions that are not declarations", () => {
    const source = `/**
 * Wrap defineWorkflow( in an exported const declaration.
 */
const registry = [defineWorkflow];
`;
    expect(findWorkflowDefinitions({ source })).toEqual([]);
  });

  it("tolerates flexible whitespace around the declaration", () => {
    const source = `  export const spaced = defineWorkflow (({ defineBoundary }) => ({
  steps: [defineBoundary({ run: () => "ok" })],
}));
`;
    expect(findWorkflowDefinitions({ source })).toEqual([
      { name: "spaced", line: 1 },
    ]);
  });
});
