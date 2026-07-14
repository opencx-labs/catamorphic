import { parseProject } from "@catamorphic/parser";
import { WORKFLOW_PACKAGE_VERSION } from "@catamorphic/workflow";
import { describe, expect, it } from "vitest";
import { findTemplate } from "../templates.js";

describe("customer feedback batch template", () => {
  it("parses as a complete batch workflow graph", () => {
    const template = findTemplate("customer-feedback-analysis");
    if (!template) throw new Error("Customer feedback template is missing");

    expect(template.files["src/batch.ts"]).toBeUndefined();
    expect(template.files["src/customer-feedback.ts"]).toContain(
      'from "@catamorphic/workflow"',
    );
    expect(JSON.parse(template.files["package.json"] ?? "{}")).toMatchObject({
      dependencies: {
        "@catamorphic/workflow": WORKFLOW_PACKAGE_VERSION,
      },
    });

    const parsed = parseProject(template.files);

    expect(parsed.errors).toEqual([]);
    expect(parsed.workflows).toHaveLength(1);
    expect(parsed.workflows[0]).toMatchObject({
      functionName: "analyzeCustomerFeedback",
      kind: "batch",
    });
    expect(parsed.workflows[0]?.graph.nodes.map((node) => node.type)).toEqual(
      expect.arrayContaining(["source", "step", "sink"]),
    );
  });
});
