import { describe, expect, it } from "vitest";
import { parseProject, parseWorkflowFromProject } from "../parser.js";
import { executionFiles } from "../types.js";

describe("parseProject", () => {
  it("discovers a single workflow from a single file", () => {
    const files = {
      "src/welcome.ts": `
export const welcomeUser = defineWorkflow(({ defineBoundary }) => ({
  steps: [
    defineBoundary({
      run: async ({ input }: BoundaryContext<{ email: string }>) => {
        await sendEmail({ to: input.email });
      },
    }),
  ],
}));

async function sendEmail({ to }: { to: string }) {
  "use step";
}
`,
    };

    const result = parseProject(files);

    expect(result.errors).toHaveLength(0);
    expect(result.workflows).toHaveLength(1);
    expect(result.workflows[0]?.functionName).toBe("welcomeUser");
    expect(result.workflows[0]?.filePath).toContain("welcome.ts");
    expect(result.workflows[0]?.graph.name).toBe("welcomeUser");
    expect(result.workflows[0]?.graph.projectFiles).toEqual(["src/welcome.ts"]);
  });

  it("ignores frontend app sources when discovering workflows and steps", () => {
    const files = {
      "workflows/src/welcome.ts": `
export const welcomeUser = defineWorkflow(({ defineBoundary }) => ({
  steps: [
    defineBoundary({
      run: async ({ input }: BoundaryContext<{ email: string }>) => {
        await sendEmail({ to: input.email });
      },
    }),
  ],
}));

/**
 * @displayname Send Email
 */
async function sendEmail({ to }: { to: string }) {
  "use step";
}
`,
      // Same step name in app code must not override the workflow's step, and
      // an app-side workflow definition must not be discovered.
      "apps/dashboard/src/main.tsx": `
async function sendEmail({ to }: { to: string }) {
  "use step";
}

export const appSideWorkflow = defineWorkflow(({ defineBoundary }) => ({
  steps: [defineBoundary({ run: async ({ input }) => input })],
}));
`,
    };

    const result = parseProject(files);

    expect(result.errors).toHaveLength(0);
    expect(result.workflows.map((workflow) => workflow.functionName)).toEqual([
      "welcomeUser",
    ]);
    const step = result.workflows[0]?.graph.nodes.find(
      (node) => node.type === "step",
    );
    expect(step?.label).toBe("Send Email");
  });

  it("discovers multiple workflows across multiple files", () => {
    const files = {
      "src/welcome.ts": `
export const welcomeUser = defineWorkflow(({ defineBoundary }) => ({
  steps: [
    defineBoundary({
      run: async ({ input }: BoundaryContext<{ email: string }>) => {
        await greet({ name: input.email });
      },
    }),
  ],
}));

async function greet({ name }: { name: string }) {
  "use step";
}
`,
      "src/order.ts": `
export const processOrder = defineWorkflow(({ defineBoundary }) => ({
  steps: [
    defineBoundary({
      run: async ({ input }: BoundaryContext<{ orderId: string }>) => {
        await validateOrder({ orderId: input.orderId });
      },
    }),
  ],
}));

async function validateOrder({ orderId }: { orderId: string }) {
  "use step";
}
`,
    };

    const result = parseProject(files);

    expect(result.errors).toHaveLength(0);
    expect(result.workflows).toHaveLength(2);

    const names = result.workflows.map((w) => w.functionName).sort();
    expect(names).toEqual(["processOrder", "welcomeUser"]);
  });

  it("discovers step functions from other files", () => {
    const files = {
      "src/workflow.ts": `
export const myWorkflow = defineWorkflow(({ defineBoundary }) => ({
  steps: [
    defineBoundary({
      run: async ({ input }: BoundaryContext<{ email: string }>) => {
        await sendEmail({ to: input.email });
      },
    }),
  ],
}));
`,
      "src/steps/email.ts": `
/**
 * @displayname Send Email
 */
async function sendEmail({ to }: { to: string }) {
  "use step";
}
`,
    };

    const result = parseProject(files);

    expect(result.errors).toHaveLength(0);
    expect(result.workflows).toHaveLength(1);

    const graph = result.workflows[0]!.graph;
    const stepNode = graph.nodes.find((n) => n.functionName === "sendEmail");
    expect(stepNode).toBeDefined();
    expect(stepNode?.label).toBe("Send Email");
  });

  it("ignores non-TypeScript files", () => {
    const files = {
      "package.json": '{ "name": "test" }',
      "README.md": "# Test",
      "src/workflow.ts": `
export const myWorkflow = defineWorkflow(({ defineBoundary }) => ({
  steps: [
    defineBoundary({
      run: async () => {
        await doThing();
      },
    }),
  ],
}));
`,
    };

    const result = parseProject(files);

    expect(result.errors).toHaveLength(0);
    expect(result.workflows).toHaveLength(1);
  });

  it("ignores files without workflow definitions", () => {
    const files = {
      "src/workflow.ts": `
export const myWorkflow = defineWorkflow(({ defineBoundary }) => ({
  steps: [
    defineBoundary({
      run: async () => {
        await doThing();
      },
    }),
  ],
}));
`,
      "src/utils.ts": `
export function helper() {
  return 42;
}
`,
    };

    const result = parseProject(files);

    expect(result.workflows).toHaveLength(1);
    expect(result.workflows[0]?.functionName).toBe("myWorkflow");
  });

  it("returns empty when no workflows found", () => {
    const files = {
      "src/utils.ts": `
export function helper() {
  return 42;
}
`,
    };

    const result = parseProject(files);

    expect(result.workflows).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it("populates filePath on each discovered workflow", () => {
    const files = {
      "src/a.ts": `
export const workflowA = defineWorkflow(({ defineBoundary }) => ({
  steps: [defineBoundary({ run: async () => doA() })],
}));
`,
      "src/b.ts": `
export const workflowB = defineWorkflow(({ defineBoundary }) => ({
  steps: [defineBoundary({ run: async () => doB() })],
}));
`,
    };

    const result = parseProject(files);

    for (const wf of result.workflows) {
      expect(wf.filePath).toBeDefined();
      expect(wf.graph.filePath).toBe(wf.filePath);
    }

    const paths = result.workflows.map((w) => w.filePath).sort();
    expect(paths.some((p) => p.includes("a.ts"))).toBe(true);
    expect(paths.some((p) => p.includes("b.ts"))).toBe(true);
  });

  it("sets projectFiles on each graph to all input file keys", () => {
    const files = {
      "src/workflow.ts": `
export const myWorkflow = defineWorkflow(({ defineBoundary }) => ({
  steps: [defineBoundary({ run: async () => doThing() })],
}));
`,
      "src/helpers.ts": `
export function helper() { return 1; }
`,
    };

    const result = parseProject(files);

    expect(result.workflows[0]?.graph.projectFiles).toEqual(
      expect.arrayContaining(["src/workflow.ts", "src/helpers.ts"]),
    );
  });

  it("produces correct graph structure for each discovered workflow", () => {
    const files = {
      "src/flow.ts": `
/**
 * @displayname My Flow
 * @description A test flow
 */
export const myFlow = defineWorkflow(({ defineBoundary }) => ({
  steps: [
    defineBoundary({
      run: async ({ input }: BoundaryContext<{ input: string }>) => {
        const result = await stepA({ data: input.input });
        await stepB({ value: result });
        return { done: true };
      },
    }),
  ],
}));

async function stepA({ data }: { data: string }) {
  "use step";
}
async function stepB({ value }: { value: string }) {
  "use step";
}
`,
    };

    const result = parseProject(files);
    const graph = result.workflows[0]!.graph;

    expect(graph.displayName).toBe("My Flow");
    expect(graph.description).toBe("A test flow");
    expect(graph.input.parameters).toHaveLength(1);
    expect(graph.input.parameters[0]?.name).toBe("input");

    const trigger = graph.nodes.find((n) => n.type === "input");
    expect(trigger).toBeDefined();

    const steps = graph.nodes.filter((n) => n.type === "step");
    expect(steps).toHaveLength(2);
    expect(steps[0]?.functionName).toBe("stepA");
    expect(steps[1]?.functionName).toBe("stepB");

    expect(graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: steps[0]?.id, target: steps[1]?.id }),
      ]),
    );
  });
});

describe("parseWorkflowFromProject", () => {
  it("returns the graph for a named workflow", () => {
    const files = {
      "src/a.ts": `
export const workflowA = defineWorkflow(({ defineBoundary }) => ({
  steps: [defineBoundary({ run: async () => stepOne() })],
}));
async function stepOne() { "use step"; }
`,
      "src/b.ts": `
export const workflowB = defineWorkflow(({ defineBoundary }) => ({
  steps: [defineBoundary({ run: async () => stepTwo() })],
}));
async function stepTwo() { "use step"; }
`,
    };

    const graph = parseWorkflowFromProject(files, "workflowA");

    expect(graph).not.toBeNull();
    expect(graph!.name).toBe("workflowA");

    const step = graph!.nodes.find((n) => n.type === "step");
    expect(step?.functionName).toBe("stepOne");
  });

  it("returns null for a non-existent workflow name", () => {
    const files = {
      "src/a.ts": `
export const workflowA = defineWorkflow(({ defineBoundary }) => ({
  steps: [defineBoundary({ run: async () => doThing() })],
}));
`,
      "src/b.ts": `
export const workflowB = defineWorkflow(({ defineBoundary }) => ({
  steps: [defineBoundary({ run: async () => other() })],
}));
`,
    };

    const graph = parseWorkflowFromProject(files, "nonExistent");
    expect(graph).toBeNull();
  });

  it("can resolve step functions from other files", () => {
    const files = {
      "src/main.ts": `
export const myWorkflow = defineWorkflow(({ defineBoundary }) => ({
  steps: [
    defineBoundary({
      run: async ({ input }: BoundaryContext<{ email: string }>) => {
        await sendNotification({ to: input.email });
      },
    }),
  ],
}));
`,
      "src/steps.ts": `
/**
 * @displayname Send Notification
 */
async function sendNotification({ to }: { to: string }) {
  "use step";
}
`,
    };

    const graph = parseWorkflowFromProject(files, "myWorkflow");
    expect(graph).not.toBeNull();

    const step = graph!.nodes.find(
      (n) => n.functionName === "sendNotification",
    );
    expect(step).toBeDefined();
    expect(step?.label).toBe("Send Notification");
  });

  it("resolves by workflow file path when the exported workflow was renamed", () => {
    const files = {
      "workflows/src/untitled-workflow2.ts": `
/**
 * @displayname Hello
 */
export const helloWorldWorkflow = defineWorkflow(({ defineBoundary }) => ({
  steps: [
    defineBoundary({
      run: async () => {
        await printHelloWorld();
        return { success: true };
      },
    }),
  ],
}));
async function printHelloWorld() {
  "use step";
}
`,
    };

    const graph = parseWorkflowFromProject(files, "untitledWorkflow2");
    expect(graph).not.toBeNull();
    expect(graph!.name).toBe("helloWorldWorkflow");

    const step = graph!.nodes.find((n) => n.type === "step");
    expect(step?.functionName).toBe("printHelloWorld");
  });
});

describe("declared secrets", () => {
  it("collects defineSecrets declarations with their options", () => {
    const files = {
      "workflows/src/secrets.ts": `
import { defineSecrets } from "@catamorphic/workflow";

export const secrets = defineSecrets({
  STRIPE_API_KEY: { description: "Stripe secret key" },
  REGION: { required: false, default: "eu-west-1" },
});
`,
    };

    const result = parseProject(files);

    expect(result.errors).toEqual([]);
    expect(result.secrets).toEqual([
      {
        name: "REGION",
        label: undefined,
        description: undefined,
        required: false,
        default: "eu-west-1",
        filePath: "workflows/src/secrets.ts",
      },
      {
        name: "STRIPE_API_KEY",
        label: undefined,
        description: "Stripe secret key",
        required: true,
        default: undefined,
        filePath: "workflows/src/secrets.ts",
      },
    ]);
  });

  it("reports an error when the declaration is not statically readable", () => {
    const files = {
      "workflows/src/secrets.ts": `
import { defineSecrets } from "@catamorphic/workflow";
const declarations = { STRIPE_API_KEY: {} };
export const secrets = defineSecrets(declarations);
`,
    };

    const result = parseProject(files);

    expect(result.secrets).toEqual([]);
    expect(result.errors[0]?.message).toMatch(/inline object literal/);
  });
});

describe("app-api contract surface", () => {
  const ordersFile = `
export const listOrders = defineWorkflow(({ defineBoundary }) => ({
  steps: [
    defineBoundary({
      run: async ({ input }: BoundaryContext<{ status: string }>) => [],
    }),
  ],
}));

export const refundOrder = defineWorkflow(({ defineBoundary }) => ({
  steps: [
    defineBoundary({
      run: async ({ input }: BoundaryContext<{ id: string }>) => ({
        refunded: true,
      }),
    }),
  ],
}));
`;

  it("resolves exported entries to workflows via bindings", () => {
    const files = {
      "workflows/src/orders.ts": ordersFile,
      "workflows/src/app-api.ts": `
import { listOrders, refundOrder as refund } from "./orders.js";

export const appApi = { listOrders, refundOrders: refund };
`,
    };

    const result = parseProject(files);

    expect(result.errors).toEqual([]);
    expect(result.appApi?.entries).toMatchObject([
      {
        exposedName: "listOrders",
        workflowName: "listOrders",
        capabilities: { batchProcessing: false, cancellation: false },
      },
      {
        exposedName: "refundOrders",
        workflowName: "refundOrder",
        capabilities: { batchProcessing: false, cancellation: false },
      },
    ]);
  });

  it("accepts a satisfies expression around the contract object", () => {
    const files = {
      "workflows/src/orders.ts": ordersFile,
      "workflows/src/app-api.ts": `
import { listOrders } from "./orders.js";
type AppContract = { listOrders: unknown };

export const appApi = { listOrders } satisfies AppContract;
`,
    };

    const result = parseProject(files);
    expect(result.errors).toEqual([]);
    expect(result.appApi?.entries.map((entry) => entry.workflowName)).toEqual([
      "listOrders",
    ]);
  });

  it("is null when the project has no app-api.ts", () => {
    const result = parseProject({ "workflows/src/orders.ts": ordersFile });
    expect(result.appApi).toBeNull();
    expect(result.errors).toEqual([]);
  });

  it("fails closed when an entry does not resolve to a workflow", () => {
    const files = {
      "workflows/src/orders.ts": ordersFile,
      "workflows/src/app-api.ts": `
import { listOrders } from "./orders.js";

const helper = async () => [];

export const appApi = { listOrders, sneaky: helper };
`,
    };

    const result = parseProject(files);
    // The whole surface is rejected, not just the bad entry: a partially
    // resolved surface would silently narrow an authorization set.
    expect(result.appApi).toBeNull();
    expect(result.errors.some((e) => e.message.includes("sneaky"))).toBe(true);
  });

  it("rejects computed or non-identifier entries", () => {
    const files = {
      "workflows/src/orders.ts": ordersFile,
      "workflows/src/app-api.ts": `
import * as orders from "./orders.js";

export const appApi = { listOrders: orders.listOrders };
`,
    };

    const result = parseProject(files);
    expect(result.appApi).toBeNull();
    expect(
      result.errors.some((e) => e.message.includes("identifier references")),
    ).toBe(true);
  });
});

describe("executionFiles", () => {
  it("drops app sources and strips the frontend-only runtime dependency", () => {
    const files = {
      "package.json": JSON.stringify({
        name: "root",
        workspaces: ["contracts"],
      }),
      "contracts/package.json": JSON.stringify({
        name: "@project/contracts",
        devDependencies: { "@catamorphic/app": "0.0.1" },
      }),
      "workflows/package.json": JSON.stringify({
        name: "@project/workflows",
        dependencies: { "@catamorphic/workflow": "0.0.2" },
      }),
      "workflows/src/a.ts": "export const a = 1;",
      "apps/dashboard/src/main.tsx": "export {};",
    };

    const result = executionFiles(files);

    expect(Object.keys(result).sort()).toEqual([
      "contracts/package.json",
      "package.json",
      "workflows/package.json",
      "workflows/src/a.ts",
    ]);
    expect(result["contracts/package.json"]).not.toContain("@catamorphic/app");
    // Untouched manifests pass through byte-identical (digest stability).
    expect(result["workflows/package.json"]).toBe(
      files["workflows/package.json"],
    );
  });
});
