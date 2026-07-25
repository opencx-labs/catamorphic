import { parseProject } from "@catamorphic/parser";
import { WORKFLOW_PACKAGE_VERSION } from "@catamorphic/workflow";
import { describe, expect, it } from "vitest";
import { findTemplate } from "../templates.js";

describe("durable order approval template", () => {
  it("parses complete durable workflow graphs", () => {
    const template = findTemplate("durable-order-approval");
    if (!template) throw new Error("Durable workflow template is missing");

    expect(JSON.parse(template.files["package.json"] ?? "{}")).toMatchObject({
      dependencies: {
        "@catamorphic/workflow": WORKFLOW_PACKAGE_VERSION,
      },
    });

    const parsed = parseProject(template.files);
    expect(template.files["src/approve-order.ts"]).toContain(
      "@displayname Request Approval",
    );
    expect(template.files["src/finish-order.ts"]).toContain(
      "@displayname Finalize Order",
    );
    expect(parsed.errors).toEqual([]);
    expect(
      parsed.workflows.map((workflow) => workflow.functionName).sort(),
    ).toEqual(["approveOrder", "finishOrder"]);
    const graph = parsed.workflows.find(
      (workflow) => workflow.functionName === "approveOrder",
    )?.graph;
    expect(graph).toMatchObject({
      capabilities: {
        persistedContinuations: true,
        batchProcessing: false,
        cancellation: true,
      },
      controls: { cancel: true },
    });
    expect(graph?.nodes.map((node) => node.type)).toEqual(
      expect.arrayContaining([
        "durable-boundary",
        "step",
        "pause",
        "call-workflow",
      ]),
    );
    expect(
      graph?.nodes.find(
        (node) => node.type === "durable-boundary" && node.label,
      ),
    ).toMatchObject({
      label: "Request Approval",
      description: "Create and wait for an approval request",
      metadata: { icon: "badge-check" },
      parameters: expect.arrayContaining([
        expect.objectContaining({
          name: "orderId",
          displayName: "Order ID",
        }),
      ]),
    });
  });
});
