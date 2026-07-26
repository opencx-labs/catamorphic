import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type {
  ResolvedRuntimeInvocation,
  RuntimeInvocationWorker,
  RuntimeInvocationWorkerFactory,
  RuntimeWorkerEvent,
} from "../supervisor-dispatcher.js";
import {
  RuntimeInvocationConflictError,
  RuntimeInvocationDispatcher,
  RuntimeInvocationInfrastructureError,
} from "../supervisor-dispatcher.js";
import {
  createSupervisorRequestHandler,
  startBunSupervisor,
} from "../supervisor-http.js";
import type {
  RuntimeInvocationRequest,
  RuntimeTerminalResult,
} from "../supervisor-protocol.js";
import {
  parseRuntimeInvocationRequest,
  RUNTIME_PROTOCOL_VERSION,
  toProtocolJson,
} from "../supervisor-protocol.js";

const artifactRoot = path.resolve("/deployment");
const writableRoot = path.resolve("/runs");

describe("runtime protocol JSON", () => {
  it("omits undefined object properties while preserving array positions", () => {
    expect(
      toProtocolJson({
        policy: { maxItems: 10, rateLimits: undefined },
        values: [1, undefined, 3],
      }),
    ).toEqual({
      policy: { maxItems: 10 },
      values: [1, null, 3],
    });
  });

  it("validates indexed defined-workflow targets", () => {
    const request = invocation({});
    expect(RUNTIME_PROTOCOL_VERSION).toBe(7);
    expect(() =>
      parseRuntimeInvocationRequest({
        ...request,
        kind: "durable-boundary",
      }),
    ).toThrow("requires stepIndex");
    expect(() =>
      parseRuntimeInvocationRequest({
        ...request,
        kind: "batch-source",
        target: {
          ...request.target,
          stepIndex: 1,
          operation: "unsupported",
        },
      }),
    ).toThrow("must be initialize or readPage");
    expect(
      parseRuntimeInvocationRequest({
        ...request,
        kind: "batch-step",
        target: {
          ...request.target,
          stepIndex: 2,
          operation: "process",
        },
      }).target,
    ).toEqual({
      modulePath: "workflow.ts",
      exportName: "run",
      stepIndex: 2,
      operation: "process",
    });
  });
});

describe("runtime invocation dispatcher", () => {
  it("bounds concurrent worker threads and drains queued invocations", async () => {
    const controls: Array<{
      resolve: (terminal: RuntimeTerminalResult) => void;
    }> = [];
    const factory = createWorkerFactory({
      execute: () =>
        new Promise((resolve) => {
          controls.push({ resolve });
        }),
    });
    const dispatcher = createDispatcher({ factory, maxConcurrency: 2 });

    const first = dispatcher.invoke(invocation({ invocationId: "one" }));
    const second = dispatcher.invoke(invocation({ invocationId: "two" }));
    const third = dispatcher.invoke(invocation({ invocationId: "three" }));

    await vi.waitFor(() => {
      expect(controls).toHaveLength(2);
      expect(dispatcher.health()).toMatchObject({
        activeInvocations: 2,
        queuedInvocations: 1,
      });
    });
    controls[0]?.resolve(completed("one"));
    await first;
    await vi.waitFor(() => expect(controls).toHaveLength(3));
    controls[1]?.resolve(completed("two"));
    controls[2]?.resolve(completed("three"));
    await Promise.all([second, third]);
    await vi.waitFor(() => {
      expect(dispatcher.health()).toMatchObject({
        activeInvocations: 0,
        queuedInvocations: 0,
      });
    });
  });

  it("sequences worker progress before the terminal event", async () => {
    const factory = createWorkerFactory({
      execute: async ({ onEvent }) => {
        onEvent({
          type: "step_started",
          nodeId: "node-1",
          occurrence: 0,
          name: "Double",
          input: { value: 2 },
        });
        onEvent({
          type: "step_completed",
          nodeId: "node-1",
          occurrence: 0,
          name: "Double",
          output: 4,
        });
        return completed(4);
      },
    });
    const dispatcher = createDispatcher({ factory });
    const response = await dispatcher.invoke(invocation({}));

    expect(response.events.map((event) => event.type)).toEqual([
      "accepted",
      "started",
      "step_started",
      "step_completed",
      "completed",
    ]);
    expect(response.events.map((event) => event.sequence)).toEqual([
      1, 2, 3, 4, 5,
    ]);
  });

  it("deduplicates logical invocation redelivery despite delivery metadata changes", async () => {
    let finish = (_terminal: RuntimeTerminalResult): void => {};
    const factory = createWorkerFactory({
      execute: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
    const dispatcher = createDispatcher({ factory });
    const request = invocation({});
    const first = dispatcher.invoke(request);
    const redelivery = dispatcher.invoke({
      ...request,
      attempt: 2,
      deadlineAt: new Date(Date.now() + 120_000).toISOString(),
      traceContext: { traceparent: "redelivered" },
    });
    expect(redelivery).toBe(first);
    await vi.waitFor(() => expect(factory.create).toHaveBeenCalledTimes(1));
    finish(completed(true));
    const receipt = await first;
    await expect(
      dispatcher.invoke({
        ...request,
        attempt: 3,
        deadlineAt: new Date(Date.now() + 180_000).toISOString(),
      }),
    ).resolves.toBe(receipt);
    expect(factory.create).toHaveBeenCalledTimes(1);
    expect(() =>
      dispatcher.invoke({ ...request, input: { changed: true } }),
    ).toThrow(RuntimeInvocationConflictError);
  });

  it("keeps runtime terminal failure semantic but permits infrastructure retry", async () => {
    const execute = vi
      .fn<() => Promise<RuntimeTerminalResult>>()
      .mockRejectedValueOnce(new Error("worker unavailable"))
      .mockResolvedValueOnce(completed("retried"));
    const factory = createWorkerFactory({ execute });
    const dispatcher = createDispatcher({ factory });
    const request = invocation({ invocationId: "infrastructure-retry" });

    await expect(dispatcher.invoke(request)).rejects.toBeInstanceOf(
      RuntimeInvocationInfrastructureError,
    );
    await expect(dispatcher.invoke(request)).resolves.toMatchObject({
      terminal: { status: "completed", result: "retried" },
    });
    expect(factory.create).toHaveBeenCalledTimes(2);

    const semantic = invocation({ invocationId: "semantic-failure" });
    execute.mockResolvedValueOnce({
      status: "failed",
      error: "workflow failed",
      steps: [],
    });
    const failed = await dispatcher.invoke(semantic);
    expect(failed.terminal).toMatchObject({
      status: "failed",
      error: "workflow failed",
    });
    await expect(dispatcher.invoke(semantic)).resolves.toBe(failed);
    expect(factory.create).toHaveBeenCalledTimes(3);
  });

  it("cancels active invocations and terminates their worker", async () => {
    const terminated = vi.fn(async () => {});
    const factory: RuntimeInvocationWorkerFactory = {
      create: () => ({
        execute: ({ signal }) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => reject(new Error("aborted")),
              { once: true },
            );
          }),
        terminate: terminated,
      }),
    };
    const dispatcher = createDispatcher({ factory });
    const result = dispatcher.invoke(invocation({}));
    await vi.waitFor(() =>
      expect(dispatcher.health().activeInvocations).toBe(1),
    );

    await expect(
      dispatcher.cancel({ invocationId: "invocation-1" }),
    ).resolves.toBe(true);
    await expect(result).resolves.toMatchObject({
      terminal: { status: "canceled" },
    });
    expect(terminated).toHaveBeenCalled();
  });

  it("retains completed step entries when an invocation is canceled", async () => {
    const factory = createWorkerFactory({
      execute: ({ signal, onEvent }) =>
        new Promise((_resolve, reject) => {
          onEvent({
            type: "step_started",
            nodeId: "node-1",
            occurrence: 0,
            name: "Completed before cancel",
            input: null,
          });
          onEvent({
            type: "step_completed",
            nodeId: "node-1",
            occurrence: 0,
            name: "Completed before cancel",
            output: null,
          });
          signal.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    });
    const dispatcher = createDispatcher({ factory });
    const result = dispatcher.invoke(invocation({}));
    await vi.waitFor(() =>
      expect(
        dispatcher.events({ invocationId: "invocation-1" })?.events,
      ).toHaveLength(4),
    );

    await dispatcher.cancel({ invocationId: "invocation-1" });

    await expect(result).resolves.toMatchObject({
      terminal: {
        status: "canceled",
        steps: [
          {
            nodeId: "node-1",
            occurrence: 0,
            input: null,
            output: null,
            status: "completed",
          },
        ],
      },
    });
  });

  it("retains completed step entries when an active invocation times out", async () => {
    const factory = createWorkerFactory({
      execute: ({ signal, onEvent }) =>
        new Promise((_resolve, reject) => {
          onEvent({
            type: "step_started",
            nodeId: "node-1",
            occurrence: 0,
            name: "Completed before timeout",
          });
          onEvent({
            type: "step_completed",
            nodeId: "node-1",
            occurrence: 0,
            name: "Completed before timeout",
            output: "saved",
          });
          signal.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    });
    const dispatcher = createDispatcher({ factory });

    const result = await dispatcher.invoke(
      invocation({
        invocationId: "timeout-ledger",
        deadlineAt: new Date(Date.now() + 25).toISOString(),
      }),
    );

    expect(result.terminal).toMatchObject({
      status: "timed_out",
      steps: [
        {
          nodeId: "node-1",
          occurrence: 0,
          output: "saved",
          status: "completed",
        },
      ],
    });
  });

  it("times out expired queued work without creating a worker", async () => {
    const factory = createWorkerFactory({
      execute: async () => completed(true),
    });
    const dispatcher = createDispatcher({ factory });
    const response = await dispatcher.invoke(
      invocation({ deadlineAt: "2020-01-01T00:00:00.000Z" }),
    );
    expect(response.terminal.status).toBe("timed_out");
    expect(factory.create).not.toHaveBeenCalled();
  });

  it("rejects module traversal and mismatched artifacts", () => {
    const factory = createWorkerFactory({
      execute: async () => completed(true),
    });
    const dispatcher = createDispatcher({ factory });
    expect(() =>
      dispatcher.invoke(
        invocation({
          target: { modulePath: "../escape.ts", exportName: "run" },
        }),
      ),
    ).toThrow("inside artifactRoot");
    expect(() =>
      dispatcher.invoke(
        invocation({ deploymentArtifactId: "another-artifact" }),
      ),
    ).toThrow("does not match runtime");
    expect(() =>
      dispatcher.invoke(invocation({ artifactDigest: "another-digest" })),
    ).toThrow("does not match runtime");
    expect(() =>
      dispatcher.invoke(invocation({ transformVersion: "another-transform" })),
    ).toThrow("does not match runtime");
    expect(() =>
      dispatcher.invoke(invocation({ runtimeVersion: "another-runtime" })),
    ).toThrow("does not match runtime");
  });
});

describe("supervisor request handler", () => {
  it("serves health without opening a port and protects invocation routes", async () => {
    const factory = createWorkerFactory({
      execute: async () => completed({ ok: true }),
    });
    const dispatcher = createDispatcher({ factory });
    const handler = createSupervisorRequestHandler({
      authToken: "secret",
      dispatcher,
    });

    const unauthenticatedHealth = await handler(
      new Request("http://runtime/health"),
    );
    expect(unauthenticatedHealth.status).toBe(401);
    const health = await handler(
      new Request("http://runtime/health", {
        headers: { Authorization: "Bearer secret" },
      }),
    );
    expect(health.status).toBe(200);

    const unauthorized = await handler(
      new Request("http://runtime/v1/invocations", {
        method: "POST",
        body: JSON.stringify(invocation({})),
      }),
    );
    expect(unauthorized.status).toBe(401);

    const response = await handler(
      new Request("http://runtime/v1/invocations", {
        method: "POST",
        headers: {
          Authorization: "Bearer secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(invocation({})),
      }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      terminal: { status: "completed", result: { ok: true } },
    });

    const events = await handler(
      new Request(
        "http://runtime/v1/invocations/invocation-1/events?afterSequence=2",
        { headers: { Authorization: "Bearer secret" } },
      ),
    );
    expect(events.status).toBe(200);
    await expect(events.json()).resolves.toMatchObject({
      invocationId: "invocation-1",
      done: true,
      events: [{ sequence: 3, type: "completed" }],
    });
  });

  it("validates protocol bodies and cancellation IDs", async () => {
    const factory = createWorkerFactory({
      execute: async () => completed(true),
    });
    const handler = createSupervisorRequestHandler({
      authToken: "secret",
      dispatcher: createDispatcher({ factory }),
    });
    const invalid = await handler(
      new Request("http://runtime/v1/invocations", {
        method: "POST",
        headers: { Authorization: "Bearer secret" },
        body: "{}",
      }),
    );
    expect(invalid.status).toBe(400);

    const missing = await handler(
      new Request("http://runtime/v1/invocations/missing/cancel", {
        method: "POST",
        headers: { Authorization: "Bearer secret" },
      }),
    );
    expect(missing.status).toBe(404);
  });

  it("keeps Bun.serve startup injectable", () => {
    const handler = vi.fn(async () => new Response());
    const stop = vi.fn();
    const serve = vi.fn(() => ({ stop }));

    const server = startBunSupervisor({
      handler,
      hostname: "127.0.0.1",
      port: 4319,
      serve,
    });
    expect(serve).toHaveBeenCalledWith({
      hostname: "127.0.0.1",
      port: 4319,
      fetch: handler,
    });
    server.stop(true);
    expect(stop).toHaveBeenCalledWith(true);
  });
});

function createDispatcher(args: {
  factory: RuntimeInvocationWorkerFactory;
  maxConcurrency?: number;
}): RuntimeInvocationDispatcher {
  return new RuntimeInvocationDispatcher({
    artifactRoot,
    writableRoot,
    maxConcurrency: args.maxConcurrency ?? 1,
    workerFactory: args.factory,
    artifactIdentity: {
      deploymentArtifactId: "artifact-1",
      artifactDigest: "digest-1",
      transformVersion: "transform-1",
      runtimeVersion: "runtime-1",
    },
    makeDirectory: async () => {},
  });
}

function createWorkerFactory(args: {
  execute: (args: {
    invocation: ResolvedRuntimeInvocation;
    signal: AbortSignal;
    onEvent: (event: RuntimeWorkerEvent) => void;
  }) => Promise<RuntimeTerminalResult>;
}): RuntimeInvocationWorkerFactory & {
  create: ReturnType<typeof vi.fn>;
} {
  const create = vi.fn(
    ({ invocation }: { invocation: ResolvedRuntimeInvocation }) => {
      const worker: RuntimeInvocationWorker = {
        execute: ({ signal, onEvent }) =>
          args.execute({ invocation, signal, onEvent }),
        terminate: async () => {},
      };
      return worker;
    },
  );
  return { create };
}

function invocation(
  overrides: Partial<Extract<RuntimeInvocationRequest, { kind: "workflow" }>>,
): RuntimeInvocationRequest {
  return {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    invocationId: "invocation-1",
    deploymentArtifactId: "artifact-1",
    artifactDigest: "digest-1",
    transformVersion: "transform-1",
    runtimeVersion: "runtime-1",
    kind: "workflow",
    target: { modulePath: "workflow.ts", exportName: "run" },
    input: { value: 2 },
    attempt: 1,
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}

function completed(result: unknown): RuntimeTerminalResult {
  return { status: "completed", result, steps: [] };
}
