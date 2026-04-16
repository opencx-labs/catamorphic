import { describe, expect, it } from "vitest";
import { parseProject, parseWorkflowFromProject } from "../parser.js";

describe("parseProject", () => {
  it("discovers a single workflow from a single file", () => {
    const files = {
      "src/welcome.ts": `
export async function welcomeUser({ email }: { email: string }) {
  "use workflow";
  await sendEmail({ to: email });
}

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

  it("discovers multiple workflows across multiple files", () => {
    const files = {
      "src/welcome.ts": `
export async function welcomeUser({ email }: { email: string }) {
  "use workflow";
  await greet({ name: email });
}

async function greet({ name }: { name: string }) {
  "use step";
}
`,
      "src/order.ts": `
export async function processOrder({ orderId }: { orderId: string }) {
  "use workflow";
  await validateOrder({ orderId });
}

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
export async function myWorkflow({ email }: { email: string }) {
  "use workflow";
  await sendEmail({ to: email });
}
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
export async function myWorkflow() {
  "use workflow";
  await doThing();
}
`,
    };

    const result = parseProject(files);

    expect(result.errors).toHaveLength(0);
    expect(result.workflows).toHaveLength(1);
  });

  it("ignores files without workflow directives", () => {
    const files = {
      "src/workflow.ts": `
export async function myWorkflow() {
  "use workflow";
  await doThing();
}
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
export async function workflowA() {
  "use workflow";
  await doA();
}
`,
      "src/b.ts": `
export async function workflowB() {
  "use workflow";
  await doB();
}
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
export async function myWorkflow() {
  "use workflow";
  await doThing();
}
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
export async function myFlow({ input }: { input: string }) {
  "use workflow";
  const result = await stepA({ data: input });
  await stepB({ value: result });
  return { done: true };
}

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
    expect(graph.trigger.parameters).toHaveLength(1);
    expect(graph.trigger.parameters[0]?.name).toBe("input");

    const trigger = graph.nodes.find((n) => n.type === "trigger");
    expect(trigger).toBeDefined();

    const steps = graph.nodes.filter((n) => n.type === "step");
    expect(steps).toHaveLength(2);
    expect(steps[0]?.functionName).toBe("stepA");
    expect(steps[1]?.functionName).toBe("stepB");

    const ret = graph.nodes.find((n) => n.type === "return");
    expect(ret).toBeDefined();

    expect(graph.edges.length).toBeGreaterThanOrEqual(3);
  });
});

describe("parseWorkflowFromProject", () => {
  it("returns the graph for a named workflow", () => {
    const files = {
      "src/a.ts": `
export async function workflowA() {
  "use workflow";
  await stepOne();
}
async function stepOne() { "use step"; }
`,
      "src/b.ts": `
export async function workflowB() {
  "use workflow";
  await stepTwo();
}
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
export async function workflowA() {
  "use workflow";
  await doThing();
}
`,
      "src/b.ts": `
export async function workflowB() {
  "use workflow";
  await other();
}
`,
    };

    const graph = parseWorkflowFromProject(files, "nonExistent");
    expect(graph).toBeNull();
  });

  it("can resolve step functions from other files", () => {
    const files = {
      "src/main.ts": `
export async function myWorkflow({ email }: { email: string }) {
  "use workflow";
  await sendNotification({ to: email });
}
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

  it("resolves by workflow file path when the exported function was renamed", () => {
    const files = {
      "src/untitled-workflow2.ts": `
/**
 * @displayname Hello
 */
export async function helloWorldWorkflow() {
  "use workflow";
  await printHelloWorld();
  return { success: true };
}
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
