import { describe, expect, it } from "vitest";
import {
  buildUntitledWorkflowName,
  displayNameFromWorkflowName,
  readWorkflowDisplayName,
  starterCodeForWorkflow,
  upsertWorkflowDisplayName,
  workflowFilePathFromName,
} from "./workflow-helpers";

describe("workflow helper utilities", () => {
  it("builds unique untitled workflow names", () => {
    expect(buildUntitledWorkflowName(new Set())).toBe("untitledWorkflow");
    expect(buildUntitledWorkflowName(new Set(["untitledWorkflow"]))).toBe(
      "untitledWorkflow2",
    );
    expect(
      buildUntitledWorkflowName(
        new Set(["untitledWorkflow", "untitledWorkflow2", "untitledWorkflow3"]),
      ),
    ).toBe("untitledWorkflow4");
  });

  it("creates a file path from workflow name", () => {
    expect(workflowFilePathFromName("untitledWorkflow")).toBe(
      "src/untitled-workflow.ts",
    );
    expect(workflowFilePathFromName("MyWorkflow123")).toBe(
      "src/my-workflow123.ts",
    );
  });

  it("creates display labels from workflow names", () => {
    expect(displayNameFromWorkflowName("untitledWorkflow")).toBe(
      "Untitled Workflow",
    );
    expect(displayNameFromWorkflowName("untitledWorkflow2")).toBe(
      "Untitled Workflow2",
    );
  });

  it("generates starter workflow code without required inputs", () => {
    const code = starterCodeForWorkflow(
      "untitledWorkflow",
      "Untitled Workflow",
    );
    expect(code).toContain("export async function untitledWorkflow()");
    expect(code).toContain("@displayname Untitled Workflow");
    expect(code).toContain("return { success: true };");
    expect(code).not.toContain("{ input }");
  });

  it("reads workflow display name from jsdoc", () => {
    const code = starterCodeForWorkflow(
      "untitledWorkflow",
      "Untitled Workflow",
    );
    expect(readWorkflowDisplayName(code, "untitledWorkflow")).toBe(
      "Untitled Workflow",
    );
  });

  it("updates existing @displayname in jsdoc", () => {
    const original = starterCodeForWorkflow(
      "untitledWorkflow",
      "Untitled Workflow",
    );
    const updated = upsertWorkflowDisplayName(
      original,
      "untitledWorkflow",
      "Renamed Workflow",
    );

    expect(readWorkflowDisplayName(updated, "untitledWorkflow")).toBe(
      "Renamed Workflow",
    );
    expect(updated).toContain("@displayname Renamed Workflow");
    expect(updated).not.toContain("@displayname Untitled Workflow");
  });

  it("inserts jsdoc when missing before workflow function", () => {
    const source = `export async function untitledWorkflow() {\n  "use workflow";\n  return { success: true };\n}\n`;
    const updated = upsertWorkflowDisplayName(
      source,
      "untitledWorkflow",
      "Named Workflow",
    );
    expect(updated).toContain("/**");
    expect(updated).toContain("@displayname Named Workflow");
    expect(readWorkflowDisplayName(updated, "untitledWorkflow")).toBe(
      "Named Workflow",
    );
  });
});
