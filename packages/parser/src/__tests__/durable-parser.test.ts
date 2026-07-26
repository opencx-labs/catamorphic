import { describe, expect, it } from "vitest";
import { layoutGraph, parseProject, parseWorkflow } from "../index.js";

const DURABLE_SOURCE = `
interface OrderInput {
  orderId: string;
  requestedBy?: string;
}

interface PreparedOrder {
  orderId: string;
  requestId: string;
}

/**
 * @displayname Approve Order
 * @description Request approval before finishing an order
 * @param orderId - @displayname Order ID | @description Order to approve
 */
export const approveOrder = defineWorkflow(({ defineBoundary }) => ({
  controls: { cancel: true },
  steps: [
    /**
     * @displayname Request Approval
     * @description Create and wait for approval
     * @icon badge-check
     * @param orderId - @displayname Order ID | @description Order to approve
     * @param requestedBy - @displayname Requested By | @description Requesting user
     */
    defineBoundary({
      retry: {
        maxAttempts: 3,
        backoff: { initial: "1s", maximum: "30s", multiplier: 2 },
      },
      run: async ({ input, pause }: BoundaryContext<OrderInput>) => {
        const prepared = await prepareOrder({ orderId: input.orderId });
        return pause<{ approved: boolean }, PreparedOrder>({
          timeout: "24h",
          state: prepared,
        });
      },
    }),
    defineBoundary({
      run: ({ input, callWorkflow }: BoundaryContext<{
        reason: "resumed";
        value: { approved: boolean };
        state: PreparedOrder;
      }>) => callWorkflow(finishOrder, { input: input.state }),
    }),
  ],
}));

/** @displayname Finish Order */
export const finishOrder = defineWorkflow(({ defineBoundary }) => ({
  steps: [
    defineBoundary({
      run: ({ input }: BoundaryContext<PreparedOrder>) => ({
        orderId: input.orderId,
        completed: true,
      }),
    }),
  ],
}));

/** @displayname Prepare Order @icon shield */
async function prepareOrder({ orderId }: { orderId: string }) {
  "use step";
  return { orderId, requestId: "request-1" };
}
`;

describe("durable workflow parsing", () => {
  it("discovers exported defined workflows", () => {
    const result = parseProject({ "src/approve-order.ts": DURABLE_SOURCE });

    expect(result.errors).toEqual([]);
    expect(result.workflows).toHaveLength(2);
    expect(
      result.workflows.find(
        (workflow) => workflow.functionName === "approveOrder",
      ),
    ).toMatchObject({
      functionName: "approveOrder",
      capabilities: {
        persistedContinuations: true,
        batchProcessing: false,
        cancellation: true,
      },
      graph: {
        displayName: "Approve Order",
        description: "Request approval before finishing an order",
        controls: { cancel: true },
      },
    });
  });

  it("renders boundaries, ordinary steps, pause, and child workflow calls", () => {
    const graph = parseWorkflow(DURABLE_SOURCE);
    const trigger = graph.nodes.find((node) => node.type === "trigger");
    const boundaries = graph.nodes.filter(
      (node) => node.type === "durable-boundary" && !node.parentId,
    );
    const step = graph.nodes.find(
      (node) => node.functionName === "prepareOrder",
    );
    const pause = graph.nodes.find((node) => node.type === "pause");
    const call = graph.nodes.find((node) => node.type === "call-workflow");
    const childBoundary = graph.nodes.find(
      (node) => node.type === "durable-boundary" && node.parentId === call?.id,
    );

    expect(graph.capabilities).toEqual({
      persistedContinuations: true,
      batchProcessing: false,
      cancellation: true,
    });
    expect(graph.trigger.parameters).toMatchObject([
      {
        name: "orderId",
        type: "string",
        optional: false,
        displayName: "Order ID",
      },
      { name: "requestedBy", type: "string | undefined", optional: true },
    ]);
    expect(boundaries).toHaveLength(2);
    expect(boundaries.map((boundary) => boundary.label)).toEqual([
      "Request Approval",
      "",
    ]);
    expect(boundaries[0]).toMatchObject({
      description: "Create and wait for approval",
      metadata: { icon: "badge-check" },
      parameters: [
        {
          name: "orderId",
          displayName: "Order ID",
          description: "Order to approve",
        },
        {
          name: "requestedBy",
          displayName: "Requested By",
          description: "Requesting user",
        },
      ],
    });
    expect(boundaries[0]?.metadata).toMatchObject({
      "retry:maxAttempts": "3",
      "retry:backoff.initial": '"1s"',
      "retry:backoff.maximum": '"30s"',
      "retry:backoff.multiplier": "2",
    });
    expect(step).toMatchObject({
      type: "step",
      label: "Prepare Order",
      parentId: boundaries[0]?.id,
    });
    expect(pause).toMatchObject({
      label: "Pause with timeout",
      duration: '"24h"',
      stateExpression: "prepared",
      parentId: boundaries[0]?.id,
    });
    expect(call).toMatchObject({
      label: "Call Finish Order",
      workflowName: "finishOrder",
      workflowInputExpression: "input.state",
      parentId: boundaries[1]?.id,
    });
    expect(childBoundary).toBeDefined();
    expect(
      graph.nodes.find(
        (node) =>
          node.functionName === undefined &&
          node.type === "durable-boundary" &&
          node.parentId === call?.id,
      ),
    ).toBeDefined();

    expect(graph.nodes.some((node) => node.type === "return")).toBe(false);
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: trigger?.id,
          target: boundaries[0]?.id,
        }),
        expect.objectContaining({
          source: boundaries[0]?.id,
          target: boundaries[1]?.id,
        }),
        expect.objectContaining({ source: step?.id, target: pause?.id }),
      ]),
    );
    expect(graph.edges.some((edge) => edge.source === pause?.id)).toBe(false);
  });

  it("lowers conditional transition returns into branches", () => {
    const graph = parseWorkflow(`
export const decide = defineWorkflow(({ defineBoundary }) => ({
  steps: [
    defineBoundary({
      run: ({ input, pause, callWorkflow }: BoundaryContext<{
        approved: boolean;
      }>) => input.approved
        ? callWorkflow(approvedFlow, { input })
        : pause({ timeout: "1h" }),
    }),
  ],
}));
`);

    expect(graph.nodes.filter((node) => node.type === "branch")).toHaveLength(
      2,
    );
    expect(graph.nodes.some((node) => node.type === "pause")).toBe(true);
    expect(graph.nodes.some((node) => node.type === "call-workflow")).toBe(
      true,
    );
  });

  it("resolves exported defined child workflow metadata and execution", () => {
    const result = parseProject({
      "src/parent.ts": `
export const parent = defineWorkflow(({ defineBoundary }) => ({
  steps: [
    defineBoundary({
      run: ({ input, callWorkflow }) => callWorkflow(child, { input }),
    }),
  ],
}));
`,
      "src/child.ts": `
/** @displayname Defined Child */
export const child = defineWorkflow(({ defineBoundary, defineBatch }) => ({
  steps: [
    defineBoundary({ run: async ({ input }) => prepare({ input }) }),
    defineBatch({
      failurePolicy: { mode: "fail_fast", maxFailures: 4 },
      source: ({ input }) => input.source,
      process: async ({ item }) => processItem({ item }),
    }),
  ],
}));
`,
    });
    expect(result.errors).toEqual([]);
    const parent = result.workflows.find(
      (workflow) => workflow.functionName === "parent",
    )?.graph;
    const call = parent?.nodes.find((node) => node.type === "call-workflow");

    expect(call).toMatchObject({
      label: "Call Defined Child",
      metadata: {
        childModulePath: "src/child.ts",
        childExportName: "child",
      },
      workflowTarget: {
        exportTarget: { modulePath: "src/child.ts", exportName: "child" },
        capabilities: {
          persistedContinuations: true,
          batchProcessing: true,
          cancellation: false,
        },
        execution: {
          exportTarget: { modulePath: "src/child.ts", exportName: "child" },
          steps: [
            expect.objectContaining({ type: "boundary", topLevelIndex: 0 }),
            expect.objectContaining({
              type: "batch",
              topLevelIndex: 1,
              failurePolicy: { mode: "fail_fast", maxFailures: 4 },
            }),
          ],
        },
      },
    });
    expect(call).not.toHaveProperty("kind");
  });

  it("resolves exported plain child workflow metadata and execution", () => {
    const result = parseProject({
      "src/parent.ts": `
export const parent = defineWorkflow(({ defineBoundary }) => ({
  steps: [
    defineBoundary({
      run: ({ input, callWorkflow }) => callWorkflow(plainChild, { input }),
    }),
  ],
}));
`,
      "src/plain-child.ts": `
/**
 * @displayname Plain Child
 * @description Runs without persisted continuation
 */
export async function plainChild({ value }: { value: string }) {
  "use workflow";
  return finish({ value });
}
`,
    });
    expect(result.errors).toEqual([]);
    const parent = result.workflows.find(
      (workflow) => workflow.functionName === "parent",
    )?.graph;
    const call = parent?.nodes.find((node) => node.type === "call-workflow");

    expect(call).toMatchObject({
      label: "Call Plain Child",
      description: "Runs without persisted continuation",
      metadata: {
        childModulePath: "src/plain-child.ts",
        childExportName: "plainChild",
      },
      workflowTarget: {
        exportTarget: {
          modulePath: "src/plain-child.ts",
          exportName: "plainChild",
        },
        capabilities: {
          persistedContinuations: false,
          batchProcessing: false,
          cancellation: false,
        },
        execution: {
          exportTarget: {
            modulePath: "src/plain-child.ts",
            exportName: "plainChild",
          },
          steps: [],
        },
      },
    });
    expect(
      parent?.nodes.find(
        (node) => node.functionName === "finish" && node.parentId === call?.id,
      ),
    ).toBeDefined();
    expect(call).not.toHaveProperty("kind");
  });

  it("does not resolve non-exported or inexact plain child workflows", () => {
    const result = parseProject({
      "src/parent.ts": `
export const parent = defineWorkflow(({ defineBoundary }) => ({
  steps: [
    defineBoundary({
      run: ({ input, callWorkflow }) => callWorkflow(privateChild, { input }),
    }),
  ],
}));
`,
      "src/private-child.ts": `
async function privateChild() {
  "use workflow";
}
export async function inexactChild() {
  "use workflow later";
}
`,
    });
    const call = result.workflows[0]?.graph.nodes.find(
      (node) => node.type === "call-workflow",
    );

    expect(result.errors).toEqual([]);
    expect(call?.workflowTarget).toBeUndefined();
    expect(call?.metadata.childModulePath).toBeUndefined();
  });

  it("lays out nameless boundaries as vertical containers", () => {
    const graph = parseWorkflow(DURABLE_SOURCE);
    const layout = layoutGraph({ nodes: graph.nodes, edges: graph.edges });
    const boundaries = layout.nodes.filter(
      (node) => node.type === "durable-boundary" && !node.parentId,
    );
    const pause = layout.nodes.find((node) => node.type === "pause");

    expect(boundaries).toHaveLength(2);
    expect(boundaries[0]?.height).toBeGreaterThan(100);
    expect(boundaries[1]?.position.y).toBeGreaterThan(
      boundaries[0]?.position.y ?? 0,
    );
    expect(pause?.position.y).toBeGreaterThan(0);
  });

  it("lays out collapsed scopes as compact cards", () => {
    const graph = parseWorkflow(DURABLE_SOURCE);
    const call = graph.nodes.find((node) => node.type === "call-workflow");
    if (!call) throw new Error("Expected child workflow call");
    const collapsedNodes = graph.nodes
      .filter((node) => node.id === call.id || node.parentId !== call.id)
      .map((node) =>
        node.id === call.id
          ? { ...node, metadata: { ...node.metadata, collapsed: "true" } }
          : node,
      );
    const layout = layoutGraph({ nodes: collapsedNodes, edges: graph.edges });
    const collapsed = layout.nodes.find((node) => node.id === call.id);

    expect(collapsed).toMatchObject({ width: 240, height: 52 });
  });

  it("extracts boundary rate limits into the execution descriptor", () => {
    const graph = parseWorkflow(`
export const sendCampaign = defineWorkflow(({ defineBoundary }) => ({
  steps: [
    defineBoundary({
      rateLimits: [
        { globalKey: "whatsapp", partitionKey: "sender-1", capacity: 80, refillRatePerSecond: 20, cost: 2 },
      ],
      run: async ({ input }: BoundaryContext<{ to: string }>) => sendMessage({ to: input.to }),
    }),
  ],
}));
`);

    const step = graph.execution.steps[0];
    expect(step?.type).toBe("boundary");
    expect(step?.type === "boundary" && step.rateLimits).toEqual([
      {
        globalKeyExpression: '"whatsapp"',
        partitionKeyExpression: '"sender-1"',
        capacityExpression: "80",
        refillRatePerSecondExpression: "20",
        costExpression: "2",
      },
    ]);
  });

  it("renders a named signal pause as an addressable wait", () => {
    const graph = parseWorkflow(`
export const nurture = defineWorkflow(({ defineBoundary }) => ({
  steps: [
    defineBoundary({
      run: async ({ pause }: BoundaryContext<{ contactId: string }>) =>
        pause<{ clicked: boolean }>({ timeout: "72h", signal: "reply" }),
    }),
  ],
}));
`);

    const pause = graph.nodes.find((node) => node.type === "pause");
    expect(pause?.label).toBe("Wait for 'reply'");
    expect(pause?.metadata.signal).toBe("reply");
  });

  it("rejects rate limits that are not analyzable object literals", () => {
    expect(() =>
      parseWorkflow(`
export const flow = defineWorkflow(({ defineBoundary }) => ({
  steps: [
    defineBoundary({
      rateLimits: sharedLimits,
      run: async ({ input }: BoundaryContext<{ id: string }>) => input,
    }),
  ],
}));
`),
    ).toThrow("must be an array literal");
  });

  it.each([
    {
      source: "export const flow = defineWorkflow(builder);",
      message: "inline builder function",
    },
    {
      source: `export const flow = defineWorkflow(({ defineBoundary }) => ({ steps }));`,
      message: "'steps' as an inline array",
    },
    {
      source: `export const flow = defineWorkflow(({ defineBoundary }) => ({ steps: [boundary] }));`,
      message: "direct defineBoundary or defineBatch call",
    },
  ])("reports malformed durable definitions", ({ source, message }) => {
    const result = parseProject({ "src/invalid.ts": source });

    expect(result.workflows).toEqual([]);
    expect(result.errors[0]?.message).toContain(message);
    expect(() => parseWorkflow(source)).toThrow(message);
  });
});
