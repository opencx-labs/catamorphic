import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BunWorkerFactory } from "../bun-worker.js";
import type { ResolvedRuntimeInvocation } from "../supervisor-dispatcher.js";
import { RUNTIME_PROTOCOL_VERSION } from "../supervisor-protocol.js";

describe("BunWorkerFactory", () => {
  let directory = "";

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "catamorphic-worker-"));
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  it("runs one invocation in a worker with an isolated env copy", async () => {
    const workerPath = path.join(directory, "worker.mjs");
    const workingDirectory = path.join(directory, "writable");
    await fs.mkdir(workingDirectory);
    await fs.writeFile(
      workerPath,
      `
import { parentPort, workerData } from "node:worker_threads";
parentPort.postMessage({
  type: "event",
  event: {
    type: "step_started",
    nodeId: "node-1",
    occurrence: 0,
    name: "Read env",
  },
});
parentPort.postMessage({
  type: "terminal",
  terminal: {
    status: "completed",
    result: {
      input: workerData.input,
      secret: process.env.INVOCATION_SECRET,
      workingDirectory: process.env.CATAMORPHIC_INVOCATION_CWD,
    },
    steps: [],
  },
});
`,
    );
    const invocation = resolvedInvocation({
      workingDirectory,
      env: { INVOCATION_SECRET: "isolated" },
    });
    const worker = new BunWorkerFactory({
      workerEntryUrl: new URL(`file://${workerPath}`),
    }).create({ invocation });
    const onEvent = vi.fn();

    const terminal = await worker.execute({
      signal: new AbortController().signal,
      onEvent,
    });
    await worker.terminate();

    expect(terminal).toMatchObject({
      status: "completed",
      result: {
        input: { value: 2 },
        secret: "isolated",
        workingDirectory,
      },
      steps: [],
    });
    expect(onEvent).toHaveBeenCalledOnce();
  });

  it("reports a clean process exit as worker failure", async () => {
    const workerPath = path.join(directory, "exit.mjs");
    await fs.writeFile(workerPath, "process.exit(0);");
    const worker = new BunWorkerFactory({
      workerEntryUrl: new URL(`file://${workerPath}`),
    }).create({
      invocation: resolvedInvocation({
        workingDirectory: directory,
      }),
    });

    await expect(
      worker.execute({
        signal: new AbortController().signal,
        onEvent: () => {},
      }),
    ).rejects.toThrow("before reporting a result");
  });
});

function resolvedInvocation(
  overrides: Partial<ResolvedRuntimeInvocation>,
): ResolvedRuntimeInvocation {
  return {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    invocationId: "invocation-1",
    deploymentArtifactId: "artifact-1",
    kind: "workflow",
    target: { modulePath: "workflow.mjs", exportName: "run" },
    input: { value: 2 },
    attempt: 1,
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    absoluteModulePath: "/workflow.mjs",
    workingDirectory: "/tmp",
    ...overrides,
  };
}
