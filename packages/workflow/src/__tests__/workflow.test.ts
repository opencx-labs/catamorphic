import { describe, expect, it } from "vitest";
import { type BoundaryContext, defineWorkflow } from "../index.js";

describe("workflow contracts", () => {
  it("constructs inert workflow and boundary definitions", async () => {
    const workflow = defineWorkflow(({ defineBoundary }) => ({
      controls: { cancel: true },
      steps: [
        defineBoundary({
          run: async ({ input }: BoundaryContext<{ orderId: string }>) => ({
            orderId: input.orderId,
            status: "prepared",
          }),
        }),
      ],
    }));

    expect(workflow.steps).toHaveLength(1);
    expect(workflow.controls).toEqual({ cancel: true });
    expect(Object.keys(workflow)).not.toContain("kind");
    expect(Object.keys(workflow.steps[0] ?? {})).not.toContain("kind");
    expect(Reflect.get(workflow, "kind")).toBe("durable-workflow");
    expect(Reflect.get(workflow.steps[0] ?? {}, "kind")).toBe(
      "durable-boundary",
    );

    const boundary = workflow.steps[0];
    await expect(
      boundary?.run({
        input: { orderId: "order-1" },
        pause: () => {
          throw new Error("not used");
        },
        callWorkflow: () => {
          throw new Error("not used");
        },
      }),
    ).resolves.toEqual({ orderId: "order-1", status: "prepared" });
  });
});
