import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BunWorkerFactory } from "../bun-worker.js";
import {
  type ResolvedRuntimeInvocation,
  RuntimeInvocationInfrastructureError,
} from "../supervisor-dispatcher.js";
import { RUNTIME_PROTOCOL_VERSION } from "../supervisor-protocol.js";

describe("BunWorkerFactory", () => {
  let directory = "";

  beforeEach(async () => {
    directory = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "catamorphic-worker-")),
    );
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  it("runs concurrent invocations in child processes with isolated cwd and env", async () => {
    const workerPath = path.join(directory, "child.mjs");
    const firstDirectory = path.join(directory, "first");
    const secondDirectory = path.join(directory, "second");
    await Promise.all([fs.mkdir(firstDirectory), fs.mkdir(secondDirectory)]);
    await fs.writeFile(
      workerPath,
      `
import { writeFileSync } from "node:fs";
process.on("message", (message) => {
  if (message.type !== "init") return;
  const result = {
    input: message.invocation.input,
    secret: process.env.INVOCATION_SECRET,
    workingDirectory: process.env.CATAMORPHIC_INVOCATION_CWD,
    cwd: process.cwd(),
  };
  writeFileSync("relative-output.json", JSON.stringify(result));
  process.send({
    type: "event",
    event: {
      type: "step_started",
      nodeId: "node-1",
      occurrence: 0,
      name: "Read env",
    },
  });
  process.send({
    type: "terminal",
    terminal: { status: "completed", result, steps: [] },
  });
});
`,
    );
    const factory = new BunWorkerFactory({
      workerEntryUrl: pathToFileURL(workerPath),
    });
    const firstWorker = factory.create({
      invocation: resolvedInvocation({
        invocationId: "first-invocation",
        input: { value: 1 },
        workingDirectory: firstDirectory,
        env: { INVOCATION_SECRET: "first-secret" },
      }),
    });
    const secondWorker = factory.create({
      invocation: resolvedInvocation({
        invocationId: "second-invocation",
        input: { value: 2 },
        workingDirectory: secondDirectory,
        env: { INVOCATION_SECRET: "second-secret" },
      }),
    });
    const onEvent = vi.fn();

    const [firstTerminal, secondTerminal] = await Promise.all([
      firstWorker.execute({
        signal: new AbortController().signal,
        onEvent,
      }),
      secondWorker.execute({
        signal: new AbortController().signal,
        onEvent,
      }),
    ]);
    await Promise.all([firstWorker.terminate(), secondWorker.terminate()]);

    expect(firstTerminal).toMatchObject({
      status: "completed",
      result: {
        input: { value: 1 },
        secret: "first-secret",
        workingDirectory: firstDirectory,
        cwd: firstDirectory,
      },
      steps: [],
    });
    expect(secondTerminal).toMatchObject({
      status: "completed",
      result: {
        input: { value: 2 },
        secret: "second-secret",
        workingDirectory: secondDirectory,
        cwd: secondDirectory,
      },
      steps: [],
    });
    await expect(
      fs.readFile(path.join(firstDirectory, "relative-output.json"), "utf8"),
    ).resolves.toContain("first-secret");
    await expect(
      fs.readFile(path.join(secondDirectory, "relative-output.json"), "utf8"),
    ).resolves.toContain("second-secret");
    expect(onEvent).toHaveBeenCalledTimes(2);
  });

  it("delivers abort and terminates an active invocation child", async () => {
    const childPath = path.join(directory, "cancel.mjs");
    const workingDirectory = path.join(directory, "cancel");
    await fs.mkdir(workingDirectory);
    await fs.writeFile(
      childPath,
      `
import { writeFileSync } from "node:fs";
process.on("message", (message) => {
  if (message.type === "init") {
    process.send({
      type: "event",
      event: {
        type: "step_started",
        nodeId: "node-1",
        occurrence: 0,
        name: "Wait",
      },
    });
    setInterval(() => {}, 1_000);
  }
  if (message.type === "abort") {
    writeFileSync("aborted.txt", message.reason);
  }
});
`,
    );
    const worker = new BunWorkerFactory({
      workerEntryUrl: pathToFileURL(childPath),
    }).create({
      invocation: resolvedInvocation({ workingDirectory }),
    });
    const controller = new AbortController();
    const onEvent = vi.fn();
    const execution = worker.execute({ signal: controller.signal, onEvent });
    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledOnce());

    controller.abort(new Error("cancel requested"));

    await expect(execution).rejects.toThrow("cancel requested");
    await expect(
      fs.readFile(path.join(workingDirectory, "aborted.txt"), "utf8"),
    ).resolves.toBe("cancel requested");
  });

  it("reports a clean process exit as worker failure", async () => {
    const workerPath = path.join(directory, "exit.mjs");
    await fs.writeFile(workerPath, "process.exit(0);");
    const worker = new BunWorkerFactory({
      workerEntryUrl: pathToFileURL(workerPath),
    }).create({
      invocation: resolvedInvocation({
        workingDirectory: directory,
      }),
    });

    const execution = worker.execute({
      signal: new AbortController().signal,
      onEvent: () => {},
    });
    await expect(execution).rejects.toBeInstanceOf(
      RuntimeInvocationInfrastructureError,
    );
    await expect(execution).rejects.toThrow("before reporting a result");
  });
});

function resolvedInvocation(
  overrides: Partial<
    Extract<ResolvedRuntimeInvocation, { kind: "durable-boundary" }>
  >,
): ResolvedRuntimeInvocation {
  return {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    invocationId: "invocation-1",
    deploymentArtifactId: "artifact-1",
    artifactDigest: "digest-1",
    transformVersion: "transform-1",
    runtimeVersion: "runtime-1",
    kind: "durable-boundary",
    target: { modulePath: "workflow.mjs", exportName: "run", stepIndex: 0 },
    input: { value: 2 },
    attempt: 1,
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    absoluteModulePath: "/workflow.mjs",
    workingDirectory: "/tmp",
    ...overrides,
  };
}
