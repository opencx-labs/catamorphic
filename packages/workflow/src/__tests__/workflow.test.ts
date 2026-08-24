import { describe, expect, it } from "vitest";
import {
  type BoundaryContext,
  defineWorkflow,
  RateLimitedError,
  rateLimited,
} from "../index.js";

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
        host: {} as never,
        documents: {} as never,
        connections: {} as never,
      }),
    ).resolves.toEqual({ orderId: "order-1", status: "prepared" });
  });

  it("carries declared rate limits onto the boundary", () => {
    const workflow = defineWorkflow(({ defineBoundary }) => ({
      steps: [
        defineBoundary({
          rateLimits: [
            {
              globalKey: "whatsapp",
              partitionKey: "sender-1",
              capacity: 80,
              refillRatePerSecond: 20,
            },
          ],
          run: async ({ input }: BoundaryContext<{ to: string }>) => ({
            to: input.to,
          }),
        }),
      ],
    }));

    expect(workflow.steps[0]?.rateLimits).toEqual([
      {
        globalKey: "whatsapp",
        partitionKey: "sender-1",
        capacity: 80,
        refillRatePerSecond: 20,
      },
    ]);
  });

  it("rejects rate limits that could never be satisfied", () => {
    const build = (capacity: number, cost: number) => () =>
      defineWorkflow(({ defineBoundary }) => ({
        steps: [
          defineBoundary({
            rateLimits: [
              { globalKey: "email", capacity, refillRatePerSecond: 1, cost },
            ],
            run: async ({ input }: BoundaryContext<{ id: string }>) => input,
          }),
        ],
      }));

    expect(build(5, 10)).toThrow("cost cannot exceed capacity");
    expect(build(5, 5)).not.toThrow();
  });

  it("rejects duplicate rate limit keys within one boundary", () => {
    expect(() =>
      defineWorkflow(({ defineBoundary }) => ({
        steps: [
          defineBoundary({
            rateLimits: [
              { globalKey: "wa", capacity: 10, refillRatePerSecond: 1 },
              { globalKey: "wa", capacity: 20, refillRatePerSecond: 2 },
            ],
            run: async ({ input }: BoundaryContext<{ id: string }>) => input,
          }),
        ],
      })),
    ).toThrow("must be unique");
  });

  it("reports backpressure as a distinct, inspectable error", () => {
    expect(() => rateLimited({ retryAfterMs: 1_500 })).toThrow(
      RateLimitedError,
    );
    try {
      rateLimited({ retryAfterMs: 1_500 });
    } catch (error) {
      expect((error as RateLimitedError).name).toBe("RateLimitedError");
      expect((error as RateLimitedError).retryAfterMs).toBe(1_500);
    }
    expect(() => rateLimited({ retryAfterMs: 0 })).toThrow(
      "must be a positive finite number",
    );
  });
});
