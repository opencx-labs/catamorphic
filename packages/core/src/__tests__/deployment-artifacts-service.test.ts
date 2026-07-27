import {
  EXECUTION_TRANSFORM_VERSION,
  executionFiles,
  prepareWorkflowExecution,
} from "@catamorphic/parser";
import { DEPLOYMENT_RUNTIME_VERSION } from "@catamorphic/sandbox";
import { describe, expect, it } from "vitest";
import { createDeploymentArtifactIdentity } from "../services/deployment-artifacts-service.js";

describe("deployment artifact identity", () => {
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
    if (!parent || !definedChild || !plainChild) {
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
    const plainChildIdentity = await createDeploymentArtifactIdentity({
      commitSha: "a".repeat(40),
      files: plainChild.files,
    });

    expect(parent.files).toEqual(definedChild.files);
    expect(parent.files).toEqual(plainChild.files);
    expect(parentIdentity).toEqual(definedChildIdentity);
    expect(parentIdentity).toEqual(plainChildIdentity);
    expect(parent.files["src/defined-child.ts"]).toContain(
      "__catamorphicRunStep",
    );
    expect(parent.files["src/plain-child.ts"]).toContain(
      "__catamorphicRunStep",
    );
    expect(parentIdentity).toMatchObject({
      transformVersion: EXECUTION_TRANSFORM_VERSION,
      runtimeVersion: DEPLOYMENT_RUNTIME_VERSION,
    });
    expect(parentIdentity.artifactDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is unchanged by frontend app sources", async () => {
    const workflowFiles = {
      "workflows/src/plain.ts": `
export async function plain({ value }: { value: string }) {
  "use workflow";
  return finish({ value });
}
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
