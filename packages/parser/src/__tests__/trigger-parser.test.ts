import { describe, expect, it } from "vitest";
import { parseProject } from "../index.js";

const TRIGGERED_SOURCE = `
import { defineWorkflow, trigger } from "@catamorphic/workflow";

interface TicketPayload {
  ticketId: string;
  priority: "low" | "high";
}

export const escalateTicket = defineWorkflow(({ defineBoundary }) => ({
  triggers: [
    trigger("ticket.created", {
      onlyPriority: "high",
      tags: ["vip", "sla"],
      weight: -2.5,
      nested: { enabled: true, note: null },
    }),
    trigger("ticket.reopened"),
  ],
  steps: [
    defineBoundary({
      run: async ({ input }: BoundaryContext<TicketPayload>) => ({
        escalated: input.ticketId,
      }),
    }),
  ],
}));

export const searchKb = defineWorkflow(({ defineBoundary }) => ({
  triggers: [trigger("ai.tool-call", { description: "Search the KB" })],
  steps: [
    defineBoundary({
      retry: { maxAttempts: 3 },
      run: async ({ input }: BoundaryContext<{ query: string }>) => ({
        results: input.query,
      }),
    }),
  ],
}));

export const untriggered = defineWorkflow(({ defineBoundary }) => ({
  steps: [
    defineBoundary({
      run: async ({ input }: BoundaryContext<{ value: number }>) => ({
        doubled: input.value * 2,
      }),
    }),
  ],
}));
`;

describe("trigger binding extraction", () => {
  it("extracts constant configs, defaults, and multiple bindings", () => {
    const result = parseProject({ "src/tickets.ts": TRIGGERED_SOURCE });
    expect(result.errors).toEqual([]);

    const escalate = result.workflows.find(
      (workflow) => workflow.functionName === "escalateTicket",
    );
    expect(escalate?.graph.triggers).toHaveLength(2);
    expect(escalate?.graph.triggers[0]).toMatchObject({
      kind: "ticket.created",
      config: {
        onlyPriority: "high",
        tags: ["vip", "sla"],
        weight: -2.5,
        nested: { enabled: true, note: null },
      },
    });
    // A trigger without a config argument gets the empty constant.
    expect(escalate?.graph.triggers[1]).toMatchObject({
      kind: "ticket.reopened",
      config: {},
    });

    const untriggered = result.workflows.find(
      (workflow) => workflow.functionName === "untriggered",
    );
    expect(untriggered?.graph.triggers).toEqual([]);
  });

  it("attaches bindings to the entry input node", () => {
    const result = parseProject({ "src/tickets.ts": TRIGGERED_SOURCE });
    const escalate = result.workflows.find(
      (workflow) => workflow.functionName === "escalateTicket",
    );
    const inputNode = escalate?.graph.nodes.find(
      (node) => node.type === "input",
    );
    expect(inputNode?.triggerBindings?.map((binding) => binding.kind)).toEqual([
      "ticket.created",
      "ticket.reopened",
    ]);

    const untriggered = result.workflows.find(
      (workflow) => workflow.functionName === "untriggered",
    );
    const untriggeredInput = untriggered?.graph.nodes.find(
      (node) => node.type === "input",
    );
    expect(untriggeredInput?.triggerBindings).toBeUndefined();
  });

  it("computes canSuspend from durable-wait sources", () => {
    const result = parseProject({ "src/tickets.ts": TRIGGERED_SOURCE });
    const byName = (name: string) =>
      result.workflows.find((workflow) => workflow.functionName === name);

    // Plain boundary, no retry/rateLimits/pause: hard no-suspend guarantee.
    expect(byName("escalateTicket")?.graph.canSuspend).toBe(false);
    // A retry policy alone makes suspension possible.
    expect(byName("searchKb")?.graph.canSuspend).toBe(true);
    expect(byName("untriggered")?.graph.canSuspend).toBe(false);
  });

  it("marks pause-capable workflows as suspendable", () => {
    const result = parseProject({
      "src/pausing.ts": `
export const withPause = defineWorkflow(({ defineBoundary }) => ({
  triggers: [trigger("ticket.created")],
  steps: [
    defineBoundary({
      run: async ({ input, pause }: BoundaryContext<{ id: string }>) => {
        return pause<{ ok: boolean }>({ timeout: "1h" });
      },
    }),
  ],
}));
`,
    });
    expect(result.errors).toEqual([]);
    expect(result.workflows[0]?.graph.canSuspend).toBe(true);
  });

  it("rejects computed trigger config", () => {
    const result = parseProject({
      "src/bad.ts": `
const description = "Search the KB";
export const searchKb = defineWorkflow(({ defineBoundary }) => ({
  triggers: [trigger("ai.tool-call", { description })],
  steps: [
    defineBoundary({
      run: async ({ input }: BoundaryContext<{ query: string }>) => ({ ok: true }),
    }),
  ],
}));
`,
    });
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]?.message).toContain("constant");
  });

  it("rejects a computed kind name", () => {
    const result = parseProject({
      "src/bad-kind.ts": `
const KIND = "ticket.created";
export const escalate = defineWorkflow(({ defineBoundary }) => ({
  triggers: [trigger(KIND)],
  steps: [
    defineBoundary({
      run: async ({ input }: BoundaryContext<{ id: string }>) => ({ ok: true }),
    }),
  ],
}));
`,
    });
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]?.message).toContain("string literal");
  });
});
