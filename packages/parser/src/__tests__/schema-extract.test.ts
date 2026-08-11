import { describe, expect, it } from "vitest";
import { parseProject } from "../index.js";

describe("workflow IO schema extraction", () => {
  it("derives input and output schemas from boundary types", () => {
    const result = parseProject({
      "workflows/src/tickets.ts": `
import { type BoundaryContext, defineWorkflow } from "@catamorphic/workflow";

interface TicketInput {
  ticketId: string;
  priority: "low" | "high";
  tags?: string[];
  score: number;
  meta: { source: string; attempts: number };
}

export const escalate = defineWorkflow(({ defineBoundary }) => ({
  steps: [
    defineBoundary({
      run: async ({ input }: BoundaryContext<TicketInput>) => ({
        escalated: input.ticketId,
        level: input.priority === "high" ? 1 : 2,
      }),
    }),
  ],
}));
`,
    });
    expect(result.errors).toEqual([]);
    const graph = result.workflows[0]?.graph;
    expect(graph?.inputSchema).toEqual({
      type: "object",
      properties: {
        ticketId: { type: "string" },
        priority: { enum: ["low", "high"] },
        tags: { type: "array", items: { type: "string" } },
        score: { type: "number" },
        meta: {
          type: "object",
          properties: {
            source: { type: "string" },
            attempts: { type: "number" },
          },
          required: ["source", "attempts"],
        },
      },
      required: ["ticketId", "priority", "score", "meta"],
    });
    expect(graph?.outputSchema).toEqual({
      type: "object",
      properties: {
        escalated: { type: "string" },
        level: { type: "number" },
      },
      required: ["escalated", "level"],
    });
    // Per-parameter schemas ride along for form rendering.
    const priority = graph?.input.parameters.find(
      (parameter) => parameter.name === "priority",
    );
    expect(priority?.schema).toEqual({ enum: ["low", "high"] });
  });

  it("resolves types imported from @project/contracts", () => {
    const result = parseProject({
      "contracts/src/index.ts": `
export interface Order { id: string; total: number; status: "open" | "shipped" }
`,
      "workflows/src/orders.ts": `
import type { Order } from "@project/contracts";
import { type BoundaryContext, defineWorkflow } from "@catamorphic/workflow";

export const shipOrder = defineWorkflow(({ defineBoundary }) => ({
  steps: [
    defineBoundary({
      run: async ({ input }: BoundaryContext<Order>) => ({ shipped: input.id }),
    }),
  ],
}));
`,
    });
    expect(result.errors).toEqual([]);
    const graph = result.workflows[0]?.graph;
    expect(graph?.inputSchema).toEqual({
      type: "object",
      properties: {
        id: { type: "string" },
        total: { type: "number" },
        status: { enum: ["open", "shipped"] },
      },
      required: ["id", "total", "status"],
    });
    // The old behavior collapsed contracts imports to one opaque `input`
    // parameter; with resolution they flatten like local types.
    expect(
      graph?.input.parameters.map((parameter) => parameter.name).sort(),
    ).toEqual(["id", "status", "total"]);
  });

  it("resolves pause transitions in output schemas", () => {
    const result = parseProject({
      "workflows/src/approval.ts": `
import { type BoundaryContext, defineWorkflow } from "@catamorphic/workflow";

export const approve = defineWorkflow(({ defineBoundary }) => ({
  steps: [
    defineBoundary({
      run: ({ input, pause }: BoundaryContext<{ orderId: string }>) =>
        pause<{ approved: boolean }, { orderId: string }>({
          timeout: "24h",
          state: { orderId: input.orderId },
        }),
    }),
  ],
}));
`,
    });
    expect(result.errors).toEqual([]);
    const output = result.workflows[0]?.graph.outputSchema as {
      anyOf?: unknown[];
    };
    // PauseResult is a union of resumed/timed_out arms.
    expect(output.anyOf).toHaveLength(2);
    expect(JSON.stringify(output)).toContain('"resumed"');
    expect(JSON.stringify(output)).toContain('"timed_out"');
  });

  it("degrades unknowable types to the permissive schema", () => {
    const result = parseProject({
      "workflows/src/loose.ts": `
import { type BoundaryContext, defineWorkflow } from "@catamorphic/workflow";

export const loose = defineWorkflow(({ defineBoundary }) => ({
  steps: [
    defineBoundary({
      run: async ({ input }: BoundaryContext<{ value: unknown }>) => input.value,
    }),
  ],
}));
`,
    });
    expect(result.errors).toEqual([]);
    const graph = result.workflows[0]?.graph;
    expect(graph?.inputSchema).toEqual({
      type: "object",
      properties: { value: {} },
      required: ["value"],
    });
    expect(graph?.outputSchema).toEqual({});
  });

  it("joins schemas onto app-api entries", () => {
    const result = parseProject({
      "workflows/src/orders.ts": `
import { type BoundaryContext, defineWorkflow } from "@catamorphic/workflow";

export const listOrders = defineWorkflow(({ defineBoundary }) => ({
  steps: [
    defineBoundary({
      run: async ({ input }: BoundaryContext<{ limit: number }>) => ({
        orders: [] as string[],
      }),
    }),
  ],
}));
`,
      "workflows/src/app-api.ts": `
import { listOrders } from "./orders.js";

export const appApi = { listOrders };
`,
    });
    expect(result.errors).toEqual([]);
    const entry = result.appApi?.entries[0];
    expect(entry?.inputSchema).toEqual({
      type: "object",
      properties: { limit: { type: "number" } },
      required: ["limit"],
    });
    expect(entry?.outputSchema).toEqual({
      type: "object",
      properties: {
        orders: { type: "array", items: { type: "string" } },
      },
      required: ["orders"],
    });
  });
});
