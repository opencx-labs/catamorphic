import { RUNTIME_PROTOCOL_VERSION } from "@catamorphic/runtime";
import { describe, expect, it, vi } from "vitest";
import { StdioDeploymentRuntimeProvider } from "../stdio-deployment-runtime.js";

const args = {
  sandboxId: "sandbox",
  workingDirectory: "/workspace/project",
  deploymentArtifactId: "artifact",
  artifactDigest: "digest",
  transformVersion: "transform",
  runtimeVersion: "runtime",
};
const ready = new TextEncoder().encode(
  `${JSON.stringify({ kind: "ready", protocolVersion: RUNTIME_PROTOCOL_VERSION })}\n`,
);

describe("stdio runtime ownership", () => {
  it("backpressures supervisor output while its durable event sink is stalled", async () => {
    let begin: ((id: number) => void) | undefined;
    const invoked = new Promise<number>((resolve) => {
      begin = resolve;
    });
    let release: (() => void) | undefined;
    const stalled = new Promise<void>((resolve) => {
      release = resolve;
    });
    let stop: (() => void) | undefined;
    const stopped = new Promise<void>((resolve) => {
      stop = resolve;
    });
    let delivered = 0;
    const frame = (value: unknown) =>
      new TextEncoder().encode(`${JSON.stringify(value)}\n`);
    const events = [1, 2].map((sequence) => ({
      type: "accepted",
      invocationId: "invocation",
      sequence,
      attempt: 1,
      timestamp: new Date().toISOString(),
    }));
    const provider = new StdioDeploymentRuntimeProvider({
      uploadFiles: async () => {},
      mkdirp: async () => {},
      openSupervisor: async () => ({
        write: async (value) => {
          begin?.(JSON.parse(value).id);
        },
        kill: async () => {
          stop?.();
        },
        stdout: (async function* () {
          yield ready;
          const id = await invoked;
          for (const event of events) {
            delivered++;
            yield frame({
              kind: "events",
              invocationId: "invocation",
              events: [event],
            });
          }
          yield frame({
            kind: "response",
            id,
            ok: true,
            body: {
              protocolVersion: RUNTIME_PROTOCOL_VERSION,
              invocationId: "invocation",
              events,
              terminal: { status: "completed", result: null, steps: [] },
            },
          });
          await stopped;
        })(),
      }),
    });
    const runtime = await provider.ensureRuntime(args);
    const report = vi.fn(async () => {
      await stalled;
    });
    const result = provider.invoke({
      ...args,
      runtimeId: runtime.runtimeId,
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      invocationId: "invocation",
      kind: "durable-boundary",
      target: { modulePath: "workflow.ts", exportName: "run", stepIndex: 0 },
      input: null,
      attempt: 1,
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      eventSink: { report },
    });
    try {
      await vi.waitFor(() => expect(report).toHaveBeenCalledOnce());
      expect(delivered).toBe(1);
      release?.();
      await expect(result).resolves.toMatchObject({
        terminal: { status: "completed" },
      });
      expect(report).toHaveBeenCalledTimes(2);
    } finally {
      release?.();
      await provider.shutdown();
    }
  });

  it("forgets every exited supervisor instead of retaining replaced channels", async () => {
    const provider = new StdioDeploymentRuntimeProvider({
      uploadFiles: async () => {},
      mkdirp: async () => {},
      openSupervisor: async () => ({
        write: async () => {},
        kill: async () => {},
        stdout: (async function* () {
          yield ready;
        })(),
      }),
    });
    for (let i = 0; i < 100; i++) {
      const runtime = await provider.ensureRuntime(args);
      await new Promise((resolve) => setImmediate(resolve));
      await expect(
        provider.getHealth({ runtimeId: runtime.runtimeId }),
      ).resolves.toMatchObject({ runtimeStatus: "error" });
    }
    expect(Reflect.get(provider, "runtimes").size).toBe(0);
    expect(Reflect.get(provider, "runtimeKeys").size).toBe(0);
    await provider.shutdown();
  });

  it("coalesces concurrent starts and releases the channel with its sandbox", async () => {
    let finish: (() => void) | undefined;
    const stopped = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const kill = vi.fn(async () => {
      finish?.();
    });
    const openSupervisor = vi.fn(async () => ({
      write: async () => {},
      kill,
      stdout: (async function* () {
        yield ready;
        await stopped;
      })(),
    }));
    const provider = new StdioDeploymentRuntimeProvider({
      uploadFiles: async () => {},
      mkdirp: async () => {},
      openSupervisor,
    });
    const [one, two] = await Promise.all([
      provider.ensureRuntime(args),
      provider.ensureRuntime(args),
    ]);
    expect(one.runtimeId).toBe(two.runtimeId);
    expect(openSupervisor).toHaveBeenCalledOnce();
    await provider.releaseSandbox({ sandboxId: args.sandboxId });
    expect(kill).toHaveBeenCalledOnce();
    await expect(
      provider.getHealth({ runtimeId: one.runtimeId }),
    ).resolves.toMatchObject({ runtimeStatus: "error" });
  });
});
