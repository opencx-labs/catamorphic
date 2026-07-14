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

  it("deduplicates matching invocation IDs and rejects conflicting reuse", () => {
    const factory = createWorkerFactory({
      execute: async () => completed(true),
    });
    const dispatcher = createDispatcher({ factory });
    const request = invocation({});
    expect(dispatcher.invoke(request)).toBe(dispatcher.invoke(request));
    expect(() =>
      dispatcher.invoke({ ...request, input: { changed: true } }),
    ).toThrow(RuntimeInvocationConflictError);
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
    ).toThrow("expected");
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
    deploymentArtifactId: "artifact-1",
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
  overrides: Partial<RuntimeInvocationRequest>,
): RuntimeInvocationRequest {
  return {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    invocationId: "invocation-1",
    deploymentArtifactId: "artifact-1",
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
