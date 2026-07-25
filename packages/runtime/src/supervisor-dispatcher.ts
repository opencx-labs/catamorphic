import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type {
  RuntimeArtifactIdentity,
  RuntimeInvocationEvent,
  RuntimeInvocationEventsResponse,
  RuntimeInvocationRequest,
  RuntimeInvocationResponse,
  RuntimeSupervisorHealth,
  RuntimeTerminalResult,
} from "./supervisor-protocol.js";
import {
  RUNTIME_PROTOCOL_VERSION,
  toProtocolJson,
} from "./supervisor-protocol.js";

export type ResolvedRuntimeInvocation = RuntimeInvocationRequest & {
  absoluteModulePath: string;
  workingDirectory: string;
};

export type RuntimeWorkerEvent =
  | {
      type: "step_started";
      nodeId: string;
      occurrence: number;
      name: string;
      input?: unknown;
    }
  | {
      type: "step_completed";
      nodeId: string;
      occurrence: number;
      name: string;
      output?: unknown;
    }
  | {
      type: "step_failed";
      nodeId: string;
      occurrence: number;
      name: string;
      error: string;
    };

export interface RuntimeInvocationWorker {
  execute(args: {
    signal: AbortSignal;
    onEvent: (event: RuntimeWorkerEvent) => void;
  }): Promise<RuntimeTerminalResult>;
  terminate(): Promise<void>;
}

export interface RuntimeInvocationWorkerFactory {
  create(args: {
    invocation: ResolvedRuntimeInvocation;
  }): RuntimeInvocationWorker;
}

interface InvocationState {
  request: RuntimeInvocationRequest;
  resolved: ResolvedRuntimeInvocation;
  fingerprint: string;
  events: RuntimeInvocationEvent[];
  promise: Promise<RuntimeInvocationResponse>;
  resolve: (response: RuntimeInvocationResponse) => void;
  reject: (error: unknown) => void;
  status: "queued" | "active" | "done";
  abortController: AbortController;
  worker?: RuntimeInvocationWorker;
  deadlineTimer?: ReturnType<typeof setTimeout>;
}

export interface RuntimeInvocationDispatcherOptions {
  artifactRoot: string;
  writableRoot: string;
  maxConcurrency: number;
  workerFactory: RuntimeInvocationWorkerFactory;
  artifactIdentity?: RuntimeArtifactIdentity;
  maxRetainedInvocations?: number;
  now?: () => Date;
  makeDirectory?: (path: string) => Promise<void>;
}

export class RuntimeInvocationConflictError extends Error {}

export class RuntimeInvocationInfrastructureError extends Error {
  constructor(args: { invocationId: string; cause: unknown }) {
    super(
      `Invocation '${args.invocationId}' failed in runtime infrastructure: ${errorMessage(args.cause)}`,
      {
        cause: args.cause,
      },
    );
    this.name = "RuntimeInvocationInfrastructureError";
  }
}

export class RuntimeInvocationDispatcher {
  private readonly states = new Map<string, InvocationState>();
  private readonly queue: InvocationState[] = [];
  private readonly maxRetainedInvocations: number;
  private readonly now: () => Date;
  private readonly makeDirectory: (path: string) => Promise<void>;
  private activeCount = 0;

  constructor(private readonly options: RuntimeInvocationDispatcherOptions) {
    if (
      !Number.isInteger(options.maxConcurrency) ||
      options.maxConcurrency < 1
    ) {
      throw new Error("Supervisor maxConcurrency must be a positive integer");
    }
    this.maxRetainedInvocations = options.maxRetainedInvocations ?? 1_000;
    this.now = options.now ?? (() => new Date());
    this.makeDirectory =
      options.makeDirectory ??
      ((directory) => mkdir(directory, { recursive: true }).then(() => {}));
  }

  invoke(
    request: RuntimeInvocationRequest,
  ): Promise<RuntimeInvocationResponse> {
    this.assertArtifact(request);
    const fingerprint = invocationFingerprint(request);
    const existing = this.states.get(request.invocationId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new RuntimeInvocationConflictError(
          `Invocation '${request.invocationId}' already exists with different input`,
        );
      }
      return existing.promise;
    }

    const deferred = createDeferred<RuntimeInvocationResponse>();
    const state: InvocationState = {
      request,
      resolved: this.resolveInvocation(request),
      fingerprint,
      events: [],
      promise: deferred.promise,
      resolve: deferred.resolve,
      reject: deferred.reject,
      status: "queued",
      abortController: new AbortController(),
    };
    this.appendEvent(state, { type: "accepted" });
    this.states.set(request.invocationId, state);
    this.queue.push(state);
    this.scheduleDeadline(state);
    this.pump();
    return state.promise;
  }

  async cancel(args: { invocationId: string }): Promise<boolean> {
    const state = this.states.get(args.invocationId);
    if (!state || state.status === "done") return false;

    state.abortController.abort(
      new Error(`Invocation '${args.invocationId}' was canceled`),
    );
    const worker = state.worker;
    this.finish(state, {
      status: "canceled",
      error: "Invocation was canceled",
      steps: completedStepLedger(state.events),
    });
    if (worker) {
      await worker.terminate().catch(() => {});
    }
    return true;
  }

  events(args: {
    invocationId: string;
    afterSequence?: number;
  }): RuntimeInvocationEventsResponse | null {
    const state = this.states.get(args.invocationId);
    if (!state) return null;
    const afterSequence = args.afterSequence ?? 0;
    return {
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      invocationId: args.invocationId,
      events: state.events.filter((event) => event.sequence > afterSequence),
      done: state.status === "done",
    };
  }

  health(): RuntimeSupervisorHealth {
    return {
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      status: "healthy",
      activeInvocations: this.activeCount,
      queuedInvocations: this.queue.filter((state) => state.status === "queued")
        .length,
      maxConcurrency: this.options.maxConcurrency,
    };
  }

  private pump(): void {
    while (
      this.activeCount < this.options.maxConcurrency &&
      this.queue.length > 0
    ) {
      const state = this.queue.shift();
      if (state?.status !== "queued") continue;
      this.activeCount += 1;
      state.status = "active";
      void this.execute(state);
    }
  }

  private async execute(state: InvocationState): Promise<void> {
    try {
      if (this.deadlineExpired(state)) {
        this.finishTimedOut(state);
        return;
      }
      await this.makeDirectory(state.resolved.workingDirectory);
      if (state.status === "done") return;

      this.appendEvent(state, {
        type: "started",
      });
      const worker = this.options.workerFactory.create({
        invocation: state.resolved,
      });
      state.worker = worker;
      const terminal = await worker.execute({
        signal: state.abortController.signal,
        onEvent: (event) => this.appendEvent(state, event),
      });
      this.finish(state, terminal);
    } catch (error) {
      if (state.status === "done") return;
      this.failInfrastructure(state, error);
    } finally {
      if (state.worker) {
        await state.worker.terminate().catch(() => {});
      }
      this.activeCount -= 1;
      this.pump();
    }
  }

  private finish(
    state: InvocationState,
    terminal: RuntimeTerminalResult,
  ): void {
    if (state.status === "done") return;
    const wasActive = state.status === "active";
    state.status = "done";
    if (state.deadlineTimer) clearTimeout(state.deadlineTimer);
    this.appendTerminalEvent(state, terminal);
    state.resolve({
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      invocationId: state.request.invocationId,
      events: state.events,
      terminal,
    });
    if (!wasActive) this.pump();
    this.pruneCompleted();
  }

  private failInfrastructure(state: InvocationState, cause: unknown): void {
    if (state.status === "done") return;
    state.status = "done";
    if (state.deadlineTimer) clearTimeout(state.deadlineTimer);
    this.states.delete(state.request.invocationId);
    state.reject(
      cause instanceof RuntimeInvocationInfrastructureError
        ? cause
        : new RuntimeInvocationInfrastructureError({
            invocationId: state.request.invocationId,
            cause,
          }),
    );
  }

  private finishTimedOut(state: InvocationState): void {
    state.abortController.abort(
      new Error(`Invocation '${state.request.invocationId}' exceeded deadline`),
    );
    if (state.worker) void state.worker.terminate().catch(() => {});
    this.finish(state, {
      status: "timed_out",
      error: "Invocation deadline exceeded",
      steps: completedStepLedger(state.events),
    });
  }

  private appendEvent(
    state: InvocationState,
    event: RuntimeWorkerEvent | { type: "accepted" } | { type: "started" },
  ): void {
    if (state.status === "done") return;
    state.events.push({
      invocationId: state.request.invocationId,
      sequence: state.events.length + 1,
      attempt: state.request.attempt,
      timestamp: this.now().toISOString(),
      ...event,
    });
  }

  private appendTerminalEvent(
    state: InvocationState,
    terminal: RuntimeTerminalResult,
  ): void {
    const common = {
      invocationId: state.request.invocationId,
      sequence: state.events.length + 1,
      attempt: state.request.attempt,
      timestamp: this.now().toISOString(),
    };
    if (terminal.status === "completed") {
      state.events.push({
        ...common,
        type: "completed",
        result: terminal.result,
      });
      return;
    }
    if (terminal.status === "suspended") {
      state.events.push({
        ...common,
        type: "suspended",
        suspension: terminal.suspension,
      });
      return;
    }
    if (terminal.status === "skipped") {
      state.events.push({
        ...common,
        type: "skipped",
        reason: terminal.reason,
      });
      return;
    }
    state.events.push({
      ...common,
      type: terminal.status,
      error: terminal.error,
    });
  }

  private scheduleDeadline(state: InvocationState): void {
    const delay = Date.parse(state.request.deadlineAt) - this.now().getTime();
    if (delay <= 0) {
      queueMicrotask(() => this.finishTimedOut(state));
      return;
    }
    state.deadlineTimer = setTimeout(
      () => {
        if (this.deadlineExpired(state)) {
          this.finishTimedOut(state);
          return;
        }
        this.scheduleDeadline(state);
      },
      Math.min(delay, 2_147_483_647),
    );
  }

  private deadlineExpired(state: InvocationState): boolean {
    return Date.parse(state.request.deadlineAt) <= this.now().getTime();
  }

  private resolveInvocation(
    request: RuntimeInvocationRequest,
  ): ResolvedRuntimeInvocation {
    const artifactRoot = path.resolve(this.options.artifactRoot);
    const absoluteModulePath = path.resolve(
      artifactRoot,
      request.target.modulePath,
    );
    const relativeModulePath = path.relative(artifactRoot, absoluteModulePath);
    if (
      relativeModulePath === "" ||
      relativeModulePath === ".." ||
      relativeModulePath.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativeModulePath)
    ) {
      throw new Error(
        "Invocation target.modulePath must resolve inside artifactRoot",
      );
    }
    const directoryName = createHash("sha256")
      .update(request.invocationId)
      .digest("hex");
    return {
      ...request,
      absoluteModulePath,
      workingDirectory: path.join(
        path.resolve(this.options.writableRoot),
        directoryName,
      ),
    };
  }

  private assertArtifact(request: RuntimeInvocationRequest): void {
    const expected = this.options.artifactIdentity;
    if (!expected) return;
    if (
      request.deploymentArtifactId !== expected.deploymentArtifactId ||
      request.artifactDigest !== expected.artifactDigest ||
      request.transformVersion !== expected.transformVersion ||
      request.runtimeVersion !== expected.runtimeVersion
    ) {
      throw new Error(
        `Invocation artifact identity does not match runtime '${expected.deploymentArtifactId}'`,
      );
    }
  }

  private pruneCompleted(): void {
    const completed = [...this.states.values()].filter(
      (state) => state.status === "done",
    );
    const excess = completed.length - this.maxRetainedInvocations;
    for (const state of completed.slice(0, Math.max(0, excess))) {
      this.states.delete(state.request.invocationId);
    }
  }
}

function completedStepLedger(
  events: readonly RuntimeInvocationEvent[],
): RuntimeTerminalResult["steps"] {
  const starts = new Map<
    string,
    Extract<RuntimeInvocationEvent, { type: "step_started" }>
  >();
  const steps: RuntimeTerminalResult["steps"][number][] = [];
  for (const event of events) {
    if (event.type === "step_started") {
      starts.set(`${event.nodeId}:${event.occurrence}`, event);
      continue;
    }
    if (event.type !== "step_completed" && event.type !== "step_failed") {
      continue;
    }
    const key = `${event.nodeId}:${event.occurrence}`;
    const started = starts.get(key);
    if (!started) continue;
    steps.push({
      nodeId: event.nodeId,
      occurrence: event.occurrence,
      name: event.name,
      status: event.type === "step_completed" ? "completed" : "failed",
      attempt: event.attempt,
      ...(Object.hasOwn(started, "input") ? { input: started.input } : {}),
      ...(event.type === "step_completed" && Object.hasOwn(event, "output")
        ? { output: event.output }
        : {}),
      ...(event.type === "step_failed" ? { error: event.error } : {}),
      startedAt: started.timestamp,
      completedAt: event.timestamp,
    });
    starts.delete(key);
  }
  return steps;
}

function createDeferred<Value>(): {
  promise: Promise<Value>;
  resolve: (value: Value) => void;
  reject: (error: unknown) => void;
} {
  let resolve = (_value: Value): void => {};
  let reject = (_error: unknown): void => {};
  const promise = new Promise<Value>((resolver, rejecter) => {
    resolve = resolver;
    reject = rejecter;
  });
  return { promise, resolve, reject };
}

function invocationFingerprint(request: RuntimeInvocationRequest): string {
  return stableStringify(
    toProtocolJson({
      protocolVersion: request.protocolVersion,
      invocationId: request.invocationId,
      deploymentArtifactId: request.deploymentArtifactId,
      artifactDigest: request.artifactDigest,
      transformVersion: request.transformVersion,
      runtimeVersion: request.runtimeVersion,
      kind: request.kind,
      target: request.target,
      input: request.input,
      replay: request.replay,
      env: request.env,
    }),
  );
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return entry;
    }
    return Object.fromEntries(
      Object.entries(entry).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    );
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
