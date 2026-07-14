import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RUNTIME_PROTOCOL_VERSION } from "@catamorphic/runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CommandDeploymentRuntimeProvider } from "../command-deployment-runtime.js";
import type {
  CreateSandboxOpts,
  ExecOpts,
  ExecResult,
  GitCloneOpts,
  RuntimeInvocation,
  RuntimeInvocationEvent,
  SandboxHandle,
  SandboxProvider,
  SandboxStatus,
} from "../types.js";
import { RuntimeEventReportingError } from "../types.js";

class LocalSandboxProvider implements SandboxProvider {
  readonly workspaceRoot: string;

  constructor(root: string) {
    this.workspaceRoot = root;
  }

  async createSandbox(_opts: CreateSandboxOpts): Promise<SandboxHandle> {
    return {
      id: "local",
      providerId: "local",
      sandboxType: "execution",
      status: "started",
    };
  }

  async startSandbox(_sandboxId: string): Promise<void> {}

  async stopSandbox(_sandboxId: string): Promise<void> {}

  async destroySandbox(_sandboxId: string): Promise<void> {}

  async getSandboxStatus(_sandboxId: string): Promise<SandboxStatus> {
    return "started";
  }

  async executeCommand(
    _sandboxId: string,
    command: string,
    opts?: ExecOpts,
  ): Promise<ExecResult> {
    return executeLocalCommand({
      command,
      cwd: opts?.cwd,
      env: opts?.env,
      timeoutSeconds: opts?.timeout,
    });
  }

  async uploadFiles(
    _sandboxId: string,
    files: Record<string, string>,
    basePath: string,
  ): Promise<void> {
    for (const [relativePath, content] of Object.entries(files)) {
      const filePath = path.join(basePath, relativePath);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, content);
    }
  }

  async downloadFile(_sandboxId: string, filePath: string): Promise<string> {
    return readFile(filePath, "utf8");
  }

  async gitClone(
    _sandboxId: string,
    _url: string,
    _targetPath: string,
    _opts?: GitCloneOpts,
  ): Promise<void> {}

  async gitCheckout(
    _sandboxId: string,
    _path: string,
    _ref: string,
  ): Promise<void> {}
}

const root = await mkdtemp(path.join(os.tmpdir(), "catamorphic-runtime-"));
const projectDirectory = path.join(root, "project");
const provider = new LocalSandboxProvider(root);
const deploymentRuntime = new CommandDeploymentRuntimeProvider({
  provider,
  port: 20_000 + Math.floor(Math.random() * 20_000),
});

describe("CommandDeploymentRuntimeProvider integration", () => {
  beforeAll(async () => {
    await provider.uploadFiles(
      "local",
      {
        "workflow.ts": `export async function greet(input: { name: string }) {
  return { message: \`hello \${input.name}\`, invocation: process.env.CATAMORPHIC_INVOCATION_ID };
}`,
        "batch-workflow.mjs": `const classify = Object.assign(
  async () => { throw new Error("batch step requires orchestration"); },
  {
    kind: "batch-step",
    batch: { maxItems: 10, maxWaitMs: 50 },
    run: async ({ items }) => items.map(({ key, value }) => ({
      key,
      status: "succeeded",
      result: value.text.includes("great") ? "positive" : "negative",
    })),
  },
);
export { classify };
export const analyze = {
  kind: "batch-workflow",
  source: async ({ input }) => ({
    config: { records: input.records },
    source: {
      consistency: "snapshot",
      initialize: async ({ config }) => ({
        snapshot: { count: config.records.length },
        cursor: 0,
        estimatedCount: config.records.length,
      }),
      readPage: async ({ config, cursor = 0, limit }) => {
        const records = config.records.slice(cursor, cursor + limit);
        const nextCursor = cursor + records.length;
        return {
          items: records.map((value, index) => ({
            key: String(cursor + index),
            value,
          })),
          nextCursor,
          done: nextCursor >= config.records.length,
        };
      },
    },
  }),
  process: async ({ item }) => {
    const category = await globalThis.__catamorphicRunStep(
      "classify-node",
      "Classify Feedback",
      (input) => classify(input),
      item,
      "classify",
    );
    return { category };
  },
};`,
      },
      projectDirectory,
    );
  });

  afterAll(async () => {
    await executeLocalCommand({
      command:
        'if [ -f supervisor.pid ]; then kill "$(cat supervisor.pid)" 2>/dev/null || true; fi',
      cwd: path.join(root, "runtime"),
    }).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });

  it("reuses one Bun supervisor for multiple isolated invocations", async () => {
    const runtime = await deploymentRuntime.ensureRuntime({
      sandboxId: "local",
      deploymentArtifactId: "artifact-1",
      workingDirectory: projectDirectory,
      maxConcurrency: 2,
    });
    const reportedEvents: RuntimeInvocationEvent[] = [];
    const first = await deploymentRuntime.invoke({
      runtimeId: runtime.runtimeId,
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      invocationId: "invocation-1",
      deploymentArtifactId: "artifact-1",
      kind: "workflow",
      target: {
        modulePath: "workflow.ts",
        exportName: "greet",
      },
      input: { name: "Ada" },
      attempt: 1,
      deadlineAt: new Date(Date.now() + 3_000).toISOString(),
      eventSink: {
        report: async ({ events }) => {
          reportedEvents.push(...events);
        },
      },
    });
    const second = await deploymentRuntime.invoke({
      runtimeId: runtime.runtimeId,
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      invocationId: "invocation-2",
      deploymentArtifactId: "artifact-1",
      kind: "workflow",
      target: {
        modulePath: "workflow.ts",
        exportName: "greet",
      },
      input: { name: "Grace" },
      attempt: 1,
      deadlineAt: new Date(Date.now() + 3_000).toISOString(),
    });

    expect(first.terminal).toMatchObject({
      status: "completed",
      result: { message: "hello Ada", invocation: "invocation-1" },
    });
    expect(reportedEvents.map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(reportedEvents.map((event) => event.type)).toEqual([
      "accepted",
      "started",
      "completed",
    ]);
    expect(second.terminal).toMatchObject({
      status: "completed",
      result: { message: "hello Grace", invocation: "invocation-2" },
    });
    const pid = await readFile(
      path.join(root, "runtime", "supervisor.pid"),
      "utf8",
    );
    expect(pid.trim()).toMatch(/^\d+$/);
  }, 30_000);

  it("runs source operations and suspends batchable process steps", async () => {
    const runtime = await deploymentRuntime.ensureRuntime({
      sandboxId: "local",
      deploymentArtifactId: "artifact-1",
      workingDirectory: projectDirectory,
      maxConcurrency: 2,
    });
    const common: Pick<
      RuntimeInvocation,
      | "runtimeId"
      | "protocolVersion"
      | "deploymentArtifactId"
      | "attempt"
      | "deadlineAt"
    > = {
      runtimeId: runtime.runtimeId,
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      deploymentArtifactId: "artifact-1",
      attempt: 1,
      deadlineAt: new Date(Date.now() + 5_000).toISOString(),
    };
    const initialized = await deploymentRuntime.invoke({
      ...common,
      invocationId: "batch-source-initialize",
      kind: "batch-source",
      target: {
        modulePath: "batch-workflow.mjs",
        exportName: "analyze",
        operation: "initialize",
      },
      input: {
        workflowInput: {
          records: [{ text: "great product" }, { text: "bad product" }],
        },
      },
    });
    expect(initialized.terminal).toMatchObject({
      status: "completed",
      result: {
        snapshot: { count: 2 },
        cursor: 0,
        estimatedCount: 2,
      },
    });

    const suspended = await deploymentRuntime.invoke({
      ...common,
      invocationId: "batch-process-suspend",
      kind: "batch-step",
      target: {
        modulePath: "batch-workflow.mjs",
        exportName: "analyze",
        operation: "process",
      },
      input: {
        key: "feedback-1",
        item: { text: "great product" },
        replay: {},
      },
    });
    expect(suspended.terminal).toMatchObject({
      status: "suspended",
      suspension: {
        nodeId: "classify-node",
        functionName: "classify",
        policy: { maxItems: 10, maxWaitMs: 50 },
      },
    });

    const physicalBatch = await deploymentRuntime.invoke({
      ...common,
      invocationId: "batch-step-physical",
      kind: "batch-step",
      target: {
        modulePath: "batch-workflow.mjs",
        exportName: "classify",
        operation: "run",
      },
      input: {
        items: [
          { key: "feedback-1", value: { text: "great product" } },
          { key: "feedback-2", value: { text: "bad product" } },
        ],
      },
    });
    expect(physicalBatch.terminal).toMatchObject({
      status: "completed",
      result: [
        { key: "feedback-1", status: "succeeded", result: "positive" },
        { key: "feedback-2", status: "succeeded", result: "negative" },
      ],
    });

    const resumed = await deploymentRuntime.invoke({
      ...common,
      invocationId: "batch-process-resume",
      kind: "batch-step",
      target: {
        modulePath: "batch-workflow.mjs",
        exportName: "analyze",
        operation: "process",
      },
      input: {
        key: "feedback-1",
        item: { text: "great product" },
        replay: { "classify-node:0": "positive" },
      },
    });
    expect(resumed.terminal).toMatchObject({
      status: "completed",
      result: { category: "positive" },
    });
  }, 30_000);

  it("fails the invocation handoff when durable event reporting fails", async () => {
    const runtime = await deploymentRuntime.ensureRuntime({
      sandboxId: "local",
      deploymentArtifactId: "artifact-1",
      workingDirectory: projectDirectory,
      maxConcurrency: 2,
    });
    await expect(
      deploymentRuntime.invoke({
        runtimeId: runtime.runtimeId,
        protocolVersion: RUNTIME_PROTOCOL_VERSION,
        invocationId: "reporting-failure",
        deploymentArtifactId: "artifact-1",
        kind: "workflow",
        target: {
          modulePath: "workflow.ts",
          exportName: "greet",
        },
        input: { name: "Lin" },
        attempt: 1,
        deadlineAt: new Date(Date.now() + 3_000).toISOString(),
        eventSink: {
          report: async () => {
            throw new Error("database unavailable");
          },
        },
      }),
    ).rejects.toBeInstanceOf(RuntimeEventReportingError);
  });
});

function executeLocalCommand(args: {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  timeoutSeconds?: number;
}): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-lc", args.command], {
      cwd: args.cwd,
      env: { ...process.env, ...args.env },
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    const timeout = args.timeoutSeconds
      ? setTimeout(() => child.kill("SIGKILL"), args.timeoutSeconds * 1_000)
      : undefined;
    child.on("close", (exitCode) => {
      if (timeout) clearTimeout(timeout);
      resolve({ exitCode: exitCode ?? 1, result: output });
    });
  });
}
