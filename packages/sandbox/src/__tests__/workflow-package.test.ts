import { describe, expect, it } from "vitest";
import {
  loadWorkflowPackagePayload,
  removeWorkflowPackageDependency,
  resolveWorkflowPackageFallback,
  WORKFLOW_PACKAGE_NAME,
} from "../workflow-package.js";

describe("workflow package fallback", () => {
  it("loads a complete package payload", async () => {
    const payload = await loadWorkflowPackagePayload();

    expect(payload.packageName).toBe(WORKFLOW_PACKAGE_NAME);
    expect(payload.version).toBe("0.0.2");
    expect(payload.files["package.json"]).toContain(WORKFLOW_PACKAGE_NAME);
    expect(payload.files["package.json"]).not.toContain('"bun"');
    expect(payload.files["dist/index.js"]).toContain("defineWorkflow");
    expect(payload.files["dist/index.js"]).not.toContain("defineBatchWorkflow");
    expect(payload.files["dist/index.d.ts"]).toContain("WorkflowDefinition");
    expect(payload.files["dist/batch.d.ts"]).toContain("BatchStepDefinition");
    expect(payload.files["dist/json.d.ts"]).toContain("JsonValue");
    expect(payload.files["dist/workflow.d.ts"]).toContain("BoundaryDefinition");
    expect(payload.files).not.toHaveProperty("dist/durable.d.ts");
  });

  it("resolves only an exact matching direct dependency", async () => {
    await expect(
      resolveWorkflowPackageFallback({
        packageJson: JSON.stringify({
          dependencies: { [WORKFLOW_PACKAGE_NAME]: "0.0.2" },
        }),
      }),
    ).resolves.toMatchObject({
      packageName: WORKFLOW_PACKAGE_NAME,
      version: "0.0.2",
    });

    await expect(
      resolveWorkflowPackageFallback({
        packageJson: JSON.stringify({
          dependencies: { [WORKFLOW_PACKAGE_NAME]: "^1.0.0" },
        }),
      }),
    ).resolves.toBeUndefined();
  });

  it("does not stage into blank or wrapper-only projects", async () => {
    await expect(
      resolveWorkflowPackageFallback({
        packageJson: JSON.stringify({ name: "blank-project" }),
      }),
    ).resolves.toBeUndefined();
    await expect(
      resolveWorkflowPackageFallback({
        packageJson: JSON.stringify({
          dependencies: { "@acme/workflow": "1.0.0" },
        }),
      }),
    ).resolves.toBeUndefined();
  });

  it("removes only the workflow dependency from an install manifest", () => {
    const packageJson = removeWorkflowPackageDependency({
      packageJson: JSON.stringify({
        name: "customer-project",
        dependencies: {
          [WORKFLOW_PACKAGE_NAME]: "0.0.2",
          zod: "^4.0.0",
        },
      }),
    });

    expect(JSON.parse(packageJson)).toEqual({
      name: "customer-project",
      dependencies: { zod: "^4.0.0" },
    });
  });
});
