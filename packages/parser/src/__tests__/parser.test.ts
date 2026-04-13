import { describe, expect, it } from "vitest";
import { parseWorkflow } from "../parser.js";

describe("parseWorkflow", () => {
  it("parses a simple workflow with steps", () => {
    const source = `
export async function myWorkflow({ email }: { email: string }) {
  "use workflow";
  const user = await createUser({ email });
  await sendEmail({ to: user.email });
  return { status: "done" };
}
`;
    const graph = parseWorkflow(source);

    expect(graph.name).toBe("myWorkflow");
    expect(graph.trigger.parameters).toHaveLength(1);
    expect(graph.trigger.parameters[0]?.name).toBe("email");

    const types = graph.nodes.map((n) => n.type);
    expect(types).toContain("trigger");
    expect(types).toContain("step");
    expect(types).toContain("return");

    const steps = graph.nodes.filter((n) => n.type === "step");
    expect(steps).toHaveLength(2);
    expect(steps[0]?.functionName).toBe("createUser");
    expect(steps[1]?.functionName).toBe("sendEmail");
  });

  it("parses if/else into branch containers", () => {
    const source = `
export async function myWorkflow({ x }: { x: number }) {
  "use workflow";
  if (x > 10) {
    await handleBig({ x });
  } else {
    await handleSmall({ x });
  }
}
`;
    const graph = parseWorkflow(source);

    const ifBlock = graph.nodes.find((n) => n.type === "if-block");
    expect(ifBlock).toBeDefined();

    const branches = graph.nodes.filter((n) => n.type === "branch");
    expect(branches).toHaveLength(2);
    expect(branches[0]?.condition).toContain("x > 10");
    expect(branches[1]?.label).toBe("Otherwise");

    const handleBig = graph.nodes.find((n) => n.functionName === "handleBig");
    expect(handleBig).toBeDefined();
    expect(handleBig?.parentId).toBe(branches[0]?.id);

    const handleSmall = graph.nodes.find(
      (n) => n.functionName === "handleSmall",
    );
    expect(handleSmall).toBeDefined();
    expect(handleSmall?.parentId).toBe(branches[1]?.id);
  });

  it("parses if/else-if/else into branch containers", () => {
    const source = `
export async function myWorkflow({ x }: { x: number }) {
  "use workflow";
  if (x > 100) {
    await handleHuge({ x });
  } else if (x > 10) {
    await handleBig({ x });
  } else {
    await handleSmall({ x });
  }
}
`;
    const graph = parseWorkflow(source);

    const branches = graph.nodes.filter((n) => n.type === "branch");
    expect(branches).toHaveLength(3);
    expect(branches[0]?.condition).toContain("x > 100");
    expect(branches[1]?.condition).toContain("x > 10");
    expect(branches[2]?.label).toBe("Otherwise");
  });

  it("parses sleep calls as delay nodes", () => {
    const source = `
export async function myWorkflow() {
  "use workflow";
  await doSomething();
  await sleep("7 days");
  await doSomethingElse();
}
`;
    const graph = parseWorkflow(source);

    const delayNode = graph.nodes.find((n) => n.type === "delay");
    expect(delayNode).toBeDefined();
    expect(delayNode?.duration).toBe("7 days");
  });

  it("parses Promise.all as parallel nodes", () => {
    const source = `
export async function myWorkflow() {
  "use workflow";
  await Promise.all([
    sendEmail({ to: "a@b.com" }),
    sendSlack({ channel: "#general" }),
  ]);
}
`;
    const graph = parseWorkflow(source);

    const parallelBlocks = graph.nodes.filter(
      (n) => n.type === "parallel-block",
    );
    expect(parallelBlocks.length).toBe(1);

    const childSteps = graph.nodes.filter(
      (n) => n.type === "step" && n.parentId === parallelBlocks[0]?.id,
    );
    expect(childSteps.length).toBeGreaterThanOrEqual(2);
  });

  it("extracts JSDoc metadata from workflow function", () => {
    const source = `
/**
 * @displayname Welcome Flow
 * @description Welcomes a new user
 */
export async function welcomeUser({ email }: { email: string }) {
  "use workflow";
  await sendWelcome({ email });
}
`;
    const graph = parseWorkflow(source);

    expect(graph.displayName).toBe("Welcome Flow");
    expect(graph.description).toBe("Welcomes a new user");
  });

  it("extracts step function display names from JSDoc", () => {
    const source = `
/**
 * @displayname Send Welcome Email
 */
async function sendWelcome({ email }: { email: string }) {
  "use step";
}

export async function myWorkflow({ email }: { email: string }) {
  "use workflow";
  await sendWelcome({ email });
}
`;
    const graph = parseWorkflow(source);

    const stepNode = graph.nodes.find((n) => n.type === "step");
    expect(stepNode).toBeDefined();
    expect(stepNode?.label).toBe("Send Welcome Email");
  });

  it("parses for-of loops as loop-block containers", () => {
    const source = `
export async function myWorkflow({ items }: { items: string[] }) {
  "use workflow";
  for (const item of items) {
    await processItem({ item });
  }
}
`;
    const graph = parseWorkflow(source);

    const loopBlock = graph.nodes.find((n) => n.type === "loop-block");
    expect(loopBlock).toBeDefined();
    expect(loopBlock?.loopVariable).toBe("item");
    expect(loopBlock?.loopIterable).toBe("items");

    const processItem = graph.nodes.find(
      (n) => n.functionName === "processItem",
    );
    expect(processItem).toBeDefined();
    expect(processItem?.parentId).toBe(loopBlock?.id);

    const loopEdge = graph.edges.find((e) => e.target === loopBlock?.id);
    expect(loopEdge).toBeDefined();
  });

  it("handles nested blocks", () => {
    const source = `
export async function myWorkflow({ items }: { items: string[] }) {
  "use workflow";
  for (const item of items) {
    if (item === "special") {
      await handleSpecial({ item });
    } else {
      await handleNormal({ item });
    }
  }
}
`;
    const graph = parseWorkflow(source);

    const loopBlock = graph.nodes.find((n) => n.type === "loop-block");
    expect(loopBlock).toBeDefined();

    const ifBlock = graph.nodes.find((n) => n.type === "if-block");
    expect(ifBlock).toBeDefined();
    expect(ifBlock?.parentId).toBe(loopBlock?.id);

    const branches = graph.nodes.filter((n) => n.type === "branch");
    expect(branches).toHaveLength(2);
    expect(branches[0]?.parentId).toBe(ifBlock?.id);
  });

  it("extracts step arguments with source tracking", () => {
    const source = `
/**
 * @displayname Create User
 */
async function createUser({ email, name }: { email: string; name: string }) {
  "use step";
  return { id: "usr_1", email, name };
}

/**
 * @displayname Send Welcome Email
 */
async function sendWelcomeEmail({ to, name }: { to: string; name: string }) {
  "use step";
}

export async function welcomeUser({ email, name }: { email: string; name: string }) {
  "use workflow";
  const user = await createUser({ email, name });
  await sendWelcomeEmail({ to: user.email, name: user.name });
}
`;
    const graph = parseWorkflow(source);

    const createUserNode = graph.nodes.find(
      (n) => n.functionName === "createUser",
    );
    expect(createUserNode?.arguments).toBeDefined();
    expect(createUserNode?.arguments).toHaveLength(2);
    expect(createUserNode?.arguments?.[0]?.name).toBe("email");
    expect(createUserNode?.arguments?.[0]?.value).toBe("email");
    expect(createUserNode?.arguments?.[0]?.source?.stepLabel).toBe(
      "welcomeUser",
    );

    const sendEmailNode = graph.nodes.find(
      (n) => n.functionName === "sendWelcomeEmail",
    );
    expect(sendEmailNode?.arguments).toBeDefined();
    expect(sendEmailNode?.arguments).toHaveLength(2);
    expect(sendEmailNode?.arguments?.[0]?.name).toBe("to");
    expect(sendEmailNode?.arguments?.[0]?.value).toBe("user.email");
    expect(sendEmailNode?.arguments?.[0]?.source?.variable).toBe("user");
    expect(sendEmailNode?.arguments?.[0]?.source?.stepLabel).toBe(
      "Create User",
    );
  });

  it("supports @displayname on variable declarations", () => {
    const source = `
async function createUser({ email }: { email: string }) {
  "use step";
  return { id: "usr_1", email };
}

async function sendEmail({ to }: { to: string }) {
  "use step";
}

export async function myWorkflow({ email }: { email: string }) {
  "use workflow";
  /** @displayname User Profile */
  const user = await createUser({ email });
  await sendEmail({ to: user.email });
}
`;
    const graph = parseWorkflow(source);

    const sendNode = graph.nodes.find((n) => n.functionName === "sendEmail");
    expect(sendNode?.arguments?.[0]?.source?.variable).toBe("user");
    expect(sendNode?.arguments?.[0]?.source?.variableDisplayName).toBe(
      "User Profile",
    );
  });

  it("tracks literal arguments without source", () => {
    const source = `
async function notify({ message }: { message: string }) {
  "use step";
}

export async function myWorkflow() {
  "use workflow";
  await notify({ message: "Hello world" });
}
`;
    const graph = parseWorkflow(source);

    const notifyNode = graph.nodes.find((n) => n.functionName === "notify");
    expect(notifyNode?.arguments).toHaveLength(1);
    expect(notifyNode?.arguments?.[0]?.name).toBe("message");
    expect(notifyNode?.arguments?.[0]?.value).toBe('"Hello world"');
    expect(notifyNode?.arguments?.[0]?.source).toBeUndefined();
  });

  it("throws when no workflow function found", () => {
    const source = `export function notAWorkflow() { return 42; }`;

    expect(() => parseWorkflow(source)).toThrow(
      'No function with "use workflow" directive found',
    );
  });
});
