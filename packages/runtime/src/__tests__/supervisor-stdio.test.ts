import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
  RuntimeInvocationDispatcher,
  type RuntimeInvocationWorkerFactory,
} from "../supervisor-dispatcher.js";
import {
  RUNTIME_PROTOCOL_VERSION,
  type RuntimeInvocationRequest,
  type RuntimeTerminalResult,
} from "../supervisor-protocol.js";
import {
  type StdioSupervisorFrame,
  startStdioSupervisor,
} from "../supervisor-stdio.js";

function workerFactory(args: {
  execute: (input: {
    onEvent: (event: {
      type: "step_completed";
      nodeId: string;
      occurrence: number;
      name: string;
    }) => void;
  }) => Promise<RuntimeTerminalResult>;
}): RuntimeInvocationWorkerFactory {
  return {
    create: () => ({
      execute: ({ onEvent }) => args.execute({ onEvent }),
      terminate: async () => {},
    }),
  };
}

function invocation(
  overrides?: Partial<
    Extract<RuntimeInvocationRequest, { kind: "durable-boundary" }>
  >,
): RuntimeInvocationRequest {
  return {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    invocationId: "invocation-1",
    deploymentArtifactId: "artifact-1",
    artifactDigest: "digest-1",
    transformVersion: "transform-1",
    runtimeVersion: "runtime-1",
    kind: "durable-boundary",
    target: { modulePath: "workflow.ts", exportName: "run", stepIndex: 0 },
    input: { value: 2 },
    attempt: 1,
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}

interface Harness {
  write: (frame: unknown) => void;
  writeRaw: (chunk: string) => void;
  frames: StdioSupervisorFrame[];
  waitForFrame: (
    predicate: (frame: StdioSupervisorFrame) => boolean,
  ) => Promise<StdioSupervisorFrame>;
  stop: () => void;
}

function startHarness(args: {
  execute?: (input: {
    onEvent: (event: {
      type: "step_completed";
      nodeId: string;
      occurrence: number;
      name: string;
    }) => void;
  }) => Promise<RuntimeTerminalResult>;
}): Harness {
  const input = new EventEmitter();
  const frames: StdioSupervisorFrame[] = [];
  const waiters: {
    predicate: (frame: StdioSupervisorFrame) => boolean;
    resolve: (frame: StdioSupervisorFrame) => void;
  }[] = [];
  const dispatcher = new RuntimeInvocationDispatcher({
    artifactRoot: "/tmp/artifact",
    writableRoot: "/tmp/writable",
    maxConcurrency: 2,
    makeDirectory: async () => {},
    workerFactory: workerFactory({
      execute:
        args.execute ??
        (async () => ({ status: "completed", result: 42, steps: [] })),
    }),
  });
  const supervisor = startStdioSupervisor({
    dispatcher,
    input: input as never,
    output: {
      write: (chunk: string) => {
        for (const line of chunk.split("\n")) {
          if (line.trim() === "") continue;
          const frame = JSON.parse(line) as StdioSupervisorFrame;
          frames.push(frame);
          for (const [index, waiter] of [...waiters.entries()].reverse()) {
            if (waiter.predicate(frame)) {
              waiters.splice(index, 1);
              waiter.resolve(frame);
            }
          }
        }
      },
    },
  });
  return {
    write: (frame) => input.emit("data", `${JSON.stringify(frame)}\n`),
    writeRaw: (chunk) => input.emit("data", chunk),
    frames,
    waitForFrame: (predicate) => {
      const existing = frames.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve) => waiters.push({ predicate, resolve }));
    },
    stop: () => supervisor.stop(),
  };
}

describe("stdio supervisor", () => {
  it("emits ready on start", async () => {
    const harness = startHarness({});
    const ready = await harness.waitForFrame((frame) => frame.kind === "ready");
    expect(ready).toEqual({
      kind: "ready",
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
    });
    harness.stop();
  });

  it("answers health requests", async () => {
    const harness = startHarness({});
    harness.write({ id: 1, op: "health" });
    const response = await harness.waitForFrame(
      (frame) => frame.kind === "response" && frame.id === 1,
    );
    expect(response).toMatchObject({
      kind: "response",
      ok: true,
      body: { status: "healthy", maxConcurrency: 2 },
    });
    harness.stop();
  });

  it("runs an invocation and pushes events before the response", async () => {
    const harness = startHarness({
      execute: async ({ onEvent }) => {
        onEvent({
          type: "step_completed",
          nodeId: "n1",
          occurrence: 0,
          name: "Step",
        });
        return { status: "completed", result: { answer: 42 }, steps: [] };
      },
    });
    harness.write({ id: 7, op: "invoke", request: invocation() });
    const response = await harness.waitForFrame(
      (frame) => frame.kind === "response" && frame.id === 7,
    );
    expect(response).toMatchObject({
      ok: true,
      body: {
        invocationId: "invocation-1",
        terminal: { status: "completed", result: { answer: 42 } },
      },
    });
    await harness.waitForFrame(
      (frame) => frame.kind === "events" && frame.done,
    );
    const types = harness.frames
      .filter((frame) => frame.kind === "events")
      .flatMap((frame) =>
        frame.kind === "events" ? frame.events.map((event) => event.type) : [],
      );
    expect(types).toContain("accepted");
    expect(types).toContain("step_completed");
    expect(types).toContain("completed");
    harness.stop();
  });

  it("rejects malformed invoke frames with bad_request", async () => {
    const harness = startHarness({});
    harness.write({ id: 3, op: "invoke", request: { nope: true } });
    const response = await harness.waitForFrame(
      (frame) => frame.kind === "response" && frame.id === 3,
    );
    expect(response).toMatchObject({
      ok: false,
      error: { code: "bad_request" },
    });
    harness.stop();
  });

  it("answers unknown ops and cancels for missing invocations", async () => {
    const harness = startHarness({});
    harness.write({ id: 4, op: "bogus" });
    const unknown = await harness.waitForFrame(
      (frame) => frame.kind === "response" && frame.id === 4,
    );
    expect(unknown).toMatchObject({
      ok: false,
      error: { code: "bad_request" },
    });

    harness.write({ id: 5, op: "cancel", invocationId: "missing" });
    const missing = await harness.waitForFrame(
      (frame) => frame.kind === "response" && frame.id === 5,
    );
    expect(missing).toMatchObject({ ok: false, error: { code: "not_found" } });
    harness.stop();
  });

  it("handles frames split across chunks and multiple frames per chunk", async () => {
    const harness = startHarness({});
    const line = `${JSON.stringify({ id: 9, op: "health" })}\n`;
    harness.writeRaw(line.slice(0, 10));
    harness.writeRaw(
      line.slice(10) + `${JSON.stringify({ id: 10, op: "health" })}\n`,
    );
    const first = await harness.waitForFrame(
      (frame) => frame.kind === "response" && frame.id === 9,
    );
    const second = await harness.waitForFrame(
      (frame) => frame.kind === "response" && frame.id === 10,
    );
    expect(first).toMatchObject({ ok: true });
    expect(second).toMatchObject({ ok: true });
    harness.stop();
  });
});
