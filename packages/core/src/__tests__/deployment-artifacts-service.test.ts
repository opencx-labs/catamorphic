import {
  EXECUTION_TRANSFORM_VERSION,
  executionFiles,
  prepareWorkflowExecution,
} from "@catamorphic/parser";
import { DEPLOYMENT_RUNTIME_VERSION } from "@catamorphic/sandbox";
import { describe, expect, it } from "vitest";
import { createDeploymentArtifactIdentity } from "../services/deployment-artifacts-service.js";

describe("deployment artifact identity", () => {
  // Three whole-project ts-morph parses; generous timeout for parallel CI load.
  it("identifies complete transformed project bytes independently of the selected workflow", async () => {
    const files = {
      "src/parent.ts": `
export const parent = defineWorkflow(({ defineBoundary }) => ({
  steps: [defineBoundary({
    run: ({ input, callWorkflow }) => callWorkflow(definedChild, { input }),
  })],
}));
`,
      "src/defined-child.ts": `
export const definedChild = defineWorkflow(({ defineBoundary, defineBatch }) => ({
  steps: [
    defineBatch({
      source: ({ input }) => loadItems({ input }),
      process: async ({ item }) => processItem({ item }),
    }),
    defineBoundary({
      run: ({ input, callWorkflow }) => callWorkflow(leafChild, { input }),
    }),
  ],
}));
`,
      "src/leaf-child.ts": `
export const leafChild = defineWorkflow(({ defineBoundary }) => ({
  steps: [defineBoundary({
    run: ({ input }) => finish({ input }),
  })],
}));
`,
    };
    const parent = prepareWorkflowExecution({ files, workflowName: "parent" });
    const definedChild = prepareWorkflowExecution({
      files,
      workflowName: "definedChild",
    });
    const leafChild = prepareWorkflowExecution({
      files,
      workflowName: "leafChild",
    });
    if (!parent || !definedChild || !leafChild) {
      throw new Error("Expected workflows to be prepared");
    }

    const parentIdentity = await createDeploymentArtifactIdentity({
      commitSha: "a".repeat(40),
      files: parent.files,
    });
    const definedChildIdentity = await createDeploymentArtifactIdentity({
      commitSha: "a".repeat(40),
      files: definedChild.files,
    });
    const leafChildIdentity = await createDeploymentArtifactIdentity({
      commitSha: "a".repeat(40),
      files: leafChild.files,
    });

    expect(parent.files).toEqual(definedChild.files);
    expect(parent.files).toEqual(leafChild.files);
    expect(parentIdentity).toEqual(definedChildIdentity);
    expect(parentIdentity).toEqual(leafChildIdentity);
    expect(parent.files["src/defined-child.ts"]).toContain(
      "__catamorphicRunStep",
    );
    // Only batch-process step calls are wrapped; a boundary body's step
    // calls run inline within the boundary invocation.
    expect(parent.files["src/leaf-child.ts"]).not.toContain(
      "__catamorphicRunStep",
    );
    expect(parentIdentity).toMatchObject({
      transformVersion: EXECUTION_TRANSFORM_VERSION,
      runtimeVersion: DEPLOYMENT_RUNTIME_VERSION,
    });
    expect(parentIdentity.artifactDigest).toMatch(/^[0-9a-f]{64}$/);
  }, 30_000);

  it("is unchanged by frontend app sources", async () => {
    const workflowFiles = {
      "workflows/src/deployed.ts": `
export const deployed = defineWorkflow(({ defineBoundary }) => ({
  steps: [defineBoundary({
    run: ({ input }) => finish({ input }),
  })],
}));
`,
    };
    const withApp = {
      ...workflowFiles,
      "apps/dashboard/src/main.tsx": "export const ui = 1;\n",
      "apps/dashboard/package.json": '{ "name": "dashboard" }',
    };

    const baseline = await createDeploymentArtifactIdentity({
      commitSha: "a".repeat(40),
      files: executionFiles(workflowFiles),
    });
    const withAppIdentity = await createDeploymentArtifactIdentity({
      commitSha: "a".repeat(40),
      files: executionFiles(withApp),
    });

    expect(withAppIdentity).toEqual(baseline);
  });
});
