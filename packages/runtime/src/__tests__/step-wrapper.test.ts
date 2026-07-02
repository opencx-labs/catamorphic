import { describe, expect, it } from "vitest";
import {
  findStepFunctions,
  hasUseStepDirective,
  INSTRUMENTED_MARKER,
  instrumentSource,
  wrapStep,
} from "../step-wrapper.js";
import type { StepEntry } from "../types.js";

describe("hasUseStepDirective", () => {
  it("returns true when source contains 'use step' with double quotes", () => {
    const source = `
async function myStep({ data }: { data: string }) {
  "use step";
  return data;
}`;
    expect(hasUseStepDirective(source)).toBe(true);
  });

  it("returns true when source contains 'use step' with single quotes", () => {
    const source = `
async function myStep({ data }: { data: string }) {
  'use step';
  return data;
}`;
    expect(hasUseStepDirective(source)).toBe(true);
  });

  it("returns false when source has no step directive", () => {
    const source = `
async function helper({ data }: { data: string }) {
  return data;
}`;
    expect(hasUseStepDirective(source)).toBe(false);
  });

  it("returns false for empty source", () => {
    expect(hasUseStepDirective("")).toBe(false);
  });
});

describe("findStepFunctions", () => {
  it("finds a single async step function", () => {
    const source = `
async function sendEmail({ to }: { to: string }) {
  "use step";
  console.log(to);
}`;
    const result = findStepFunctions(source);
    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe("sendEmail");
    expect(result[0]?.isAsync).toBe(true);
  });

  it("finds multiple step functions", () => {
    const source = `
async function stepA({ x }: { x: number }) {
  "use step";
  return x;
}

async function stepB({ y }: { y: string }) {
  "use step";
  return y;
}`;
    const result = findStepFunctions(source);
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.name).sort()).toEqual(["stepA", "stepB"]);
  });

  it("finds exported step functions", () => {
    const source = `
export async function myStep({ data }: { data: string }) {
  "use step";
  return data;
}`;
    const result = findStepFunctions(source);
    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe("myStep");
  });

  it("returns empty for source with no step functions", () => {
    const source = `
export async function myWorkflow() {
  "use workflow";
  await doStuff();
}`;
    const result = findStepFunctions(source);
    expect(result).toHaveLength(0);
  });

  it("ignores non-function step directives", () => {
    const source = `const x = "use step";`;
    const result = findStepFunctions(source);
    expect(result).toHaveLength(0);
  });
});

describe("instrumentSource", () => {
  it("renames step declarations and re-binds through the global wrapper", () => {
    const source = `
async function sendEmail({ to }: { to: string }) {
  "use step";
  return to;
}

export async function myWorkflow({ to }: { to: string }) {
  "use workflow";
  return sendEmail({ to });
}`;
    const result = instrumentSource(source);
    expect(result).not.toBeNull();
    expect(result).toContain("function __catamorphic_step_sendEmail");
    expect(result).toContain(
      'const sendEmail = globalThis.__catamorphicWrapStep(__catamorphic_step_sendEmail, "sendEmail");',
    );
    // Workflow function untouched.
    expect(result).toContain("export async function myWorkflow");
  });

  it("preserves export on exported step functions", () => {
    const source = `
export async function myStep({ data }: { data: string }) {
  "use step";
  return data;
}`;
    const result = instrumentSource(source);
    expect(result).toContain(
      'export const myStep = globalThis.__catamorphicWrapStep(__catamorphic_step_myStep, "myStep");',
    );
    expect(result).not.toContain("export async function __catamorphic_step_");
  });

  it("returns null when there are no step functions", () => {
    expect(instrumentSource(`export const x = 1;`)).toBeNull();
  });

  it("is idempotent via the instrumented marker", () => {
    const source = `
async function s({ x }: { x: number }) {
  "use step";
  return x;
}`;
    const first = instrumentSource(source);
    expect(first).not.toBeNull();
    expect(first!.startsWith(INSTRUMENTED_MARKER)).toBe(true);
    expect(instrumentSource(first!)).toBeNull();
  });
});

describe("wrapStep", () => {
  it("captures successful step execution", async () => {
    const stepLog: StepEntry[] = [];
    const original = async (args: { value: number }) => args.value * 2;

    const wrapped = wrapStep(
      original as (...args: unknown[]) => unknown,
      "double",
      stepLog,
    );
    const result = await wrapped({ value: 5 });

    expect(result).toBe(10);
    expect(stepLog).toHaveLength(1);
    expect(stepLog[0]?.nodeId).toBe("double");
    expect(stepLog[0]?.name).toBe("double");
    expect(stepLog[0]?.status).toBe("completed");
    expect(stepLog[0]?.input).toEqual({ value: 5 });
    expect(stepLog[0]?.output).toBe(10);
    expect(stepLog[0]?.error).toBeUndefined();
    expect(stepLog[0]?.startedAt).toBeTruthy();
    expect(stepLog[0]?.completedAt).toBeTruthy();
  });

  it("captures failed step execution", async () => {
    const stepLog: StepEntry[] = [];
    const original = async () => {
      throw new Error("step failed");
    };

    const wrapped = wrapStep(
      original as (...args: unknown[]) => unknown,
      "failing",
      stepLog,
    );

    await expect(wrapped({})).rejects.toThrow("step failed");
    expect(stepLog).toHaveLength(1);
    expect(stepLog[0]?.status).toBe("failed");
    expect(stepLog[0]?.error).toBe("step failed");
    expect(stepLog[0]?.output).toBeUndefined();
  });

  it("captures non-Error throws as strings", async () => {
    const stepLog: StepEntry[] = [];
    const original = async () => {
      throw "string error";
    };

    const wrapped = wrapStep(
      original as (...args: unknown[]) => unknown,
      "stringFail",
      stepLog,
    );

    await expect(wrapped({})).rejects.toBe("string error");
    expect(stepLog[0]?.error).toBe("string error");
  });

  it("records timing with startedAt before completedAt", async () => {
    const stepLog: StepEntry[] = [];
    const original = async () => "done";

    const wrapped = wrapStep(
      original as (...args: unknown[]) => unknown,
      "timed",
      stepLog,
    );
    await wrapped({});

    const start = new Date(stepLog[0]!.startedAt).getTime();
    const end = new Date(stepLog[0]!.completedAt).getTime();
    expect(end).toBeGreaterThanOrEqual(start);
  });

  it("appends multiple step entries to the same log", async () => {
    const stepLog: StepEntry[] = [];
    const fn1 = async () => "a";
    const fn2 = async () => "b";

    const w1 = wrapStep(fn1 as (...args: unknown[]) => unknown, "s1", stepLog);
    const w2 = wrapStep(fn2 as (...args: unknown[]) => unknown, "s2", stepLog);

    await w1({});
    await w2({});

    expect(stepLog).toHaveLength(2);
    expect(stepLog[0]?.nodeId).toBe("s1");
    expect(stepLog[1]?.nodeId).toBe("s2");
  });
});
