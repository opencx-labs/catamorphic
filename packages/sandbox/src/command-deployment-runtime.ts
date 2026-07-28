import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { RUNTIME_PROTOCOL_VERSION } from "@catamorphic/runtime";
import type {
  CancelRuntimeInvocationArgs,
  DeploymentRuntime,
  DeploymentRuntimeProvider,
  EnsureDeploymentRuntimeArgs,
  RuntimeHealth,
  RuntimeInvocation,
  RuntimeInvocationEvent,
  RuntimeInvocationEventSink,
  RuntimeInvocationEventsResponse,
  RuntimeInvocationReceipt,
  RuntimeTerminalResult,
  SandboxProvider,
} from "./types.js";
import {
  RuntimeEventReportingError,
  RuntimeInfrastructureError,
} from "./types.js";

interface RuntimeRecord {
  runtime: DeploymentRuntime;
  token: string;
  runtimeDirectory: string;
  port: number;
}

/**
 * How long the supervisor holds an event request open when nothing is ready.
 * Must stay at or below the supervisor's own ceiling; long enough that an idle
 * invocation costs few round trips, short enough that a lost response is
 * noticed promptly.
 */
const EVENT_WAIT_MS = 20_000;

/** Lets the supervisor answer a wait on its own terms before curl gives up. */
const EVENT_REQUEST_GRACE_SECONDS = 10;

/** Backoff after a failed drain, so an unreachable supervisor is not spun on. */
const EVENT_RETRY_DELAY_MS = 1_000;

type CommandOutcome =
  | {
      status: "fulfilled";
      result: { exitCode: number; result: string };
    }
  | { status: "rejected"; error: unknown };

export class CommandDeploymentRuntimeProvider
  implements DeploymentRuntimeProvider
{
  private readonly runtimes = new Map<string, RuntimeRecord>();
  private readonly runtimeKeys = new Map<string, string>();

  constructor(
    private readonly options: {
      provider: SandboxProvider;
      port?: number;
    },
  ) {}

  async ensureRuntime(
    args: EnsureDeploymentRuntimeArgs,
  ): Promise<DeploymentRuntime> {
    const key = runtimeKey(args);
    const existingId = this.runtimeKeys.get(key);
    const existing = existingId ? this.runtimes.get(existingId) : undefined;
    if (existing) {
      const health = await this.getHealth({
        runtimeId: existing.runtime.runtimeId,
      });
      if (health.runtimeStatus === "healthy") return existing.runtime;
    }

    const runtimeId = `runtime-${crypto.randomUUID()}`;
    const token = randomBytes(32).toString("base64url");
    const port = this.options.port ?? 8321;
    const runtimeDirectory = `${args.workingDirectory}/../runtime`;
    const writableRoot = `${args.workingDirectory}/../runs`;
    const generation = crypto.randomUUID();
    const files = await loadSupervisorFiles();
    await this.options.provider.uploadFiles(
      args.sandboxId,
      files,
      runtimeDirectory,
    );
    const start = await this.options.provider.executeCommand(
      args.sandboxId,
      'if [ -f supervisor.pid ]; then kill "$(cat supervisor.pid)" 2>/dev/null || true; fi; ' +
        'mkdir -p "$CATAMORPHIC_RUNTIME_WRITABLE_ROOT"; ' +
        "nohup bun run entry.mjs > supervisor.log 2>&1 < /dev/null & echo $! > supervisor.pid",
      {
        cwd: runtimeDirectory,
        timeout: 30,
        env: {
          ...(args.env ?? {}),
          CATAMORPHIC_RUNTIME_TOKEN: token,
          CATAMORPHIC_RUNTIME_ARTIFACT_ROOT: args.workingDirectory,
          CATAMORPHIC_RUNTIME_WRITABLE_ROOT: writableRoot,
          CATAMORPHIC_DEPLOYMENT_ARTIFACT_ID: args.deploymentArtifactId,
          CATAMORPHIC_ARTIFACT_DIGEST: args.artifactDigest,
          CATAMORPHIC_TRANSFORM_VERSION: args.transformVersion,
          CATAMORPHIC_RUNTIME_VERSION: args.runtimeVersion,
          CATAMORPHIC_RUNTIME_PORT: String(port),
          CATAMORPHIC_RUNTIME_MAX_CONCURRENCY: String(args.maxConcurrency ?? 4),
        },
      },
    );
    if (start.exitCode !== 0) {
      throw new Error(`Failed to start deployment runtime: ${start.result}`);
    }

    const runtime: DeploymentRuntime = {
      runtimeId,
      sandboxId: args.sandboxId,
      deploymentArtifactId: args.deploymentArtifactId,
      artifactDigest: args.artifactDigest,
      transformVersion: args.transformVersion,
      runtimeVersion: args.runtimeVersion,
      generation,
      status: "starting",
    };
    const record: RuntimeRecord = {
      runtime,
      token,
      runtimeDirectory,
      port,
    };
    this.runtimes.set(runtimeId, record);
    this.runtimeKeys.set(key, runtimeId);
    await this.waitForHealth({ runtimeId, attempts: 20 });
    runtime.status = "healthy";
    return runtime;
  }

  async invoke(args: RuntimeInvocation): Promise<RuntimeInvocationReceipt> {
    try {
      return await this.invokeInner(args);
    } catch (error) {
      if (args.signal?.aborted) throw error;
      if (error instanceof RuntimeInfrastructureError) throw error;
      throw new RuntimeInfrastructureError({
        operation: `invocation '${args.invocationId}' handoff`,
        cause: error,
      });
    }
  }

  private async invokeInner(
    args: RuntimeInvocation,
  ): Promise<RuntimeInvocationReceipt> {
    const record = this.requireRuntime(args.runtimeId);
    if (
      args.deploymentArtifactId !== record.runtime.deploymentArtifactId ||
      args.artifactDigest !== record.runtime.artifactDigest ||
      args.transformVersion !== record.runtime.transformVersion ||
      args.runtimeVersion !== record.runtime.runtimeVersion
    ) {
      throw new Error("Invocation artifact identity does not match runtime");
    }
    args.signal?.throwIfAborted();
    const requestFile = `requests/${hash(args.invocationId)}.json`;
    await this.options.provider.uploadFiles(
      record.runtime.sandboxId,
      {
        [requestFile]: JSON.stringify({
          protocolVersion: args.protocolVersion,
          invocationId: args.invocationId,
          deploymentArtifactId: args.deploymentArtifactId,
          artifactDigest: args.artifactDigest,
          transformVersion: args.transformVersion,
          runtimeVersion: args.runtimeVersion,
          kind: args.kind,
          target: args.target,
          input: args.input,
          attempt: args.attempt,
          deadlineAt: args.deadlineAt,
          replay: args.replay,
          env: args.env,
          traceContext: args.traceContext,
        }),
      },
      record.runtimeDirectory,
    );
    const timeoutSeconds = Math.max(
      1,
      Math.ceil((Date.parse(args.deadlineAt) - Date.now()) / 1_000) + 5,
    );
    const command = this.options.provider.executeCommand(
      record.runtime.sandboxId,
      `curl --fail-with-body --silent --show-error ` +
        `-H ${shellQuote(`Authorization: Bearer ${record.token}`)} ` +
        `-H 'Content-Type: application/json' ` +
        `--max-time ${timeoutSeconds} ` +
        `--data-binary @${shellQuote(requestFile)} ` +
        `http://127.0.0.1:${record.port}/v1/invocations; ` +
        `status=$?; rm -f ${shellQuote(requestFile)}; exit $status`,
      {
        cwd: record.runtimeDirectory,
        timeout: timeoutSeconds + 1,
      },
    );
    const completion = command.then<CommandOutcome, CommandOutcome>(
      (result) => ({ status: "fulfilled", result }),
      (error: unknown) => ({ status: "rejected", error }),
    );
    const cancelInvocation = (): void => {
      void this.cancel({
        runtimeId: args.runtimeId,
        invocationId: args.invocationId,
      }).catch(() => {});
    };
    args.signal?.addEventListener("abort", cancelInvocation, { once: true });
    const cursor = { sequence: 0 };
    try {
      if (args.eventSink) {
        await this.reportWhileRunning({
          record,
          invocation: args,
          completion,
          cursor,
        });
      }
      const outcome = await completion;
      if (outcome.status === "rejected") throw outcome.error;
      const result = outcome.result;
      if (result.exitCode !== 0) {
        const logs = await this.options.provider
          .downloadFile(
            record.runtime.sandboxId,
            `${record.runtimeDirectory}/supervisor.log`,
          )
          .catch(() => "");
        throw new Error(
          `Deployment runtime invocation failed: ${result.result}\n${logs}`,
        );
      }
      const receipt = parseReceipt({
        runtimeId: args.runtimeId,
        value: JSON.parse(result.result),
      });
      if (args.eventSink) {
        await reportEvents({
          sink: args.eventSink,
          runtimeId: args.runtimeId,
          invocationId: args.invocationId,
          events: receipt.events.filter(
            (event) => event.sequence > cursor.sequence,
          ),
          cursor,
        });
      }
      return receipt;
    } finally {
      args.signal?.removeEventListener("abort", cancelInvocation);
    }
  }

  async cancel(args: CancelRuntimeInvocationArgs): Promise<void> {
    const record = this.requireRuntime(args.runtimeId);
    const result = await this.options.provider.executeCommand(
      record.runtime.sandboxId,
      `curl --silent --show-error ` +
        `-H ${shellQuote(`Authorization: Bearer ${record.token}`)} ` +
        `-X POST http://127.0.0.1:${record.port}/v1/invocations/` +
        `${encodeURIComponent(args.invocationId)}/cancel`,
      { cwd: record.runtimeDirectory, timeout: 30 },
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `Deployment runtime cancellation failed: ${result.result}`,
      );
    }
  }

  async getHealth(args: { runtimeId: string }): Promise<RuntimeHealth> {
    const record = this.requireRuntime(args.runtimeId);
    const result = await this.options.provider.executeCommand(
      record.runtime.sandboxId,
      `curl --fail --silent --show-error ` +
        `-H ${shellQuote(`Authorization: Bearer ${record.token}`)} ` +
        `http://127.0.0.1:${record.port}/health`,
      { cwd: record.runtimeDirectory, timeout: 10 },
    );
    if (result.exitCode !== 0) {
      return {
        runtimeId: args.runtimeId,
        runtimeStatus: "error",
        protocolVersion: RUNTIME_PROTOCOL_VERSION,
        status: "healthy",
        activeInvocations: 0,
        queuedInvocations: 0,
        maxConcurrency: 0,
      };
    }
    const health = parseHealth(JSON.parse(result.result));
    return {
      runtimeId: args.runtimeId,
      runtimeStatus: "healthy",
      ...health,
    };
  }

  private async waitForHealth(args: {
    runtimeId: string;
    attempts: number;
  }): Promise<void> {
    for (let attempt = 0; attempt < args.attempts; attempt += 1) {
      const health = await this.getHealth({ runtimeId: args.runtimeId });
      if (health.runtimeStatus === "healthy") return;
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
    }
    const record = this.requireRuntime(args.runtimeId);
    const logs = await this.options.provider
      .downloadFile(
        record.runtime.sandboxId,
        `${record.runtimeDirectory}/supervisor.log`,
      )
      .catch(() => "");
    throw new Error(`Deployment runtime failed health check: ${logs}`);
  }

  /**
   * Drains events until the invocation completes.
   *
   * Each drain is a process spawn inside the sandbox plus a network round trip,
   * so the supervisor holds the request open until an event is ready
   * ({@link EVENT_WAIT_MS}) rather than answering empty right away. That makes
   * the cost track the number of events instead of the invocation's wall-clock
   * duration — an idle run waiting on a slow API costs nothing — while events
   * still arrive as soon as they are emitted.
   *
   * Iterative rather than recursive: a long invocation would otherwise build a
   * promise chain one frame deep per poll.
   */
  private async reportWhileRunning(args: {
    record: RuntimeRecord;
    invocation: RuntimeInvocation;
    completion: Promise<
      | { status: "fulfilled"; result: { exitCode: number; result: string } }
      | { status: "rejected"; error: unknown }
    >;
    cursor: { sequence: number };
  }): Promise<void> {
    let running = true;
    const stop = (): void => {
      running = false;
    };
    args.completion.then(stop, stop);
    // The supervisor wakes long polls the moment an invocation finishes, so
    // this observes completion without a separate timer racing each iteration.
    while (running) {
      const drained = await this.reportAvailableEvents({
        ...args,
        waitMs: EVENT_WAIT_MS,
      });
      // A failing request returns immediately rather than holding the wait, so
      // without this the loop would spin against an unreachable supervisor.
      if (!drained && running) {
        await delay({ milliseconds: EVENT_RETRY_DELAY_MS });
      }
    }
    // Events emitted between the last drain and completion are still pending;
    // this final pass must not block waiting for events that will never come.
    await this.reportAvailableEvents({ ...args, waitMs: 0 });
  }

  private async reportAvailableEvents(args: {
    record: RuntimeRecord;
    invocation: RuntimeInvocation;
    cursor: { sequence: number };
    waitMs?: number;
  }): Promise<boolean> {
    const sink = args.invocation.eventSink;
    if (!sink) return true;
    const waitMs = args.waitMs ?? 0;
    const waitSeconds = Math.ceil(waitMs / 1_000);
    const result = await this.options.provider.executeCommand(
      args.record.runtime.sandboxId,
      `curl --fail --silent --show-error ` +
        `--max-time ${waitSeconds + EVENT_REQUEST_GRACE_SECONDS} ` +
        `-H ${shellQuote(`Authorization: Bearer ${args.record.token}`)} ` +
        // The query string must be quoted: an unquoted `&` splits the shell
        // command, backgrounding curl and masking its exit code with 0.
        shellQuote(
          `http://127.0.0.1:${args.record.port}/v1/invocations/` +
            `${encodeURIComponent(args.invocation.invocationId)}/events` +
            `?afterSequence=${args.cursor.sequence}&waitMs=${waitMs}`,
        ),
      {
        cwd: args.record.runtimeDirectory,
        timeout: waitSeconds + EVENT_REQUEST_GRACE_SECONDS + 1,
      },
    );
    if (result.exitCode !== 0) return false;
    const response = parseEventsResponse(JSON.parse(result.result));
    await reportEvents({
      sink,
      runtimeId: args.invocation.runtimeId,
      invocationId: args.invocation.invocationId,
      events: response.events,
      cursor: args.cursor,
    });
    return true;
  }

  private requireRuntime(runtimeId: string): RuntimeRecord {
    const runtime = this.runtimes.get(runtimeId);
    if (!runtime)
      throw new Error(`Deployment runtime '${runtimeId}' not found`);
    return runtime;
  }
}

async function loadSupervisorFiles(): Promise<Record<string, string>> {
  const require = createRequire(import.meta.url);
  const packageJson = require.resolve("@catamorphic/runtime/package.json");
  const runtimeRoot = path.dirname(packageJson);
  const [runtimeBundle, workerBundle] = await Promise.all([
    readFile(path.join(runtimeRoot, "dist/index.js"), "utf8"),
    readFile(path.join(runtimeRoot, "dist/supervisor-worker.js"), "utf8"),
  ]);
  return {
    "runtime.js": runtimeBundle,
    "supervisor-worker.js": workerBundle,
    "entry.mjs": runtimeEntrySource(),
  };
}

function runtimeEntrySource(): string {
  return `import {
  BunWorkerFactory,
  RuntimeInvocationDispatcher,
  createSupervisorRequestHandler,
  startBunSupervisor,
} from "./runtime.js";

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(\`Missing \${name}\`);
  return value;
};
const dispatcher = new RuntimeInvocationDispatcher({
  artifactRoot: required("CATAMORPHIC_RUNTIME_ARTIFACT_ROOT"),
  writableRoot: required("CATAMORPHIC_RUNTIME_WRITABLE_ROOT"),
  artifactIdentity: {
    deploymentArtifactId: required("CATAMORPHIC_DEPLOYMENT_ARTIFACT_ID"),
    artifactDigest: required("CATAMORPHIC_ARTIFACT_DIGEST"),
    transformVersion: required("CATAMORPHIC_TRANSFORM_VERSION"),
    runtimeVersion: required("CATAMORPHIC_RUNTIME_VERSION"),
  },
  maxConcurrency: Number(process.env.CATAMORPHIC_RUNTIME_MAX_CONCURRENCY ?? "4"),
  workerFactory: new BunWorkerFactory({
    workerEntryUrl: new URL("./supervisor-worker.js", import.meta.url),
  }),
});
const handler = createSupervisorRequestHandler({
  authToken: required("CATAMORPHIC_RUNTIME_TOKEN"),
  dispatcher,
});
startBunSupervisor({
  handler,
  port: Number(process.env.CATAMORPHIC_RUNTIME_PORT ?? "8321"),
  hostname: "127.0.0.1",
});
`;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function runtimeKey(args: EnsureDeploymentRuntimeArgs): string {
  return [
    args.sandboxId,
    args.deploymentArtifactId,
    args.artifactDigest,
    args.transformVersion,
    args.runtimeVersion,
  ].join(":");
}

function parseEventsResponse(value: unknown): RuntimeInvocationEventsResponse {
  if (
    !isRecord(value) ||
    value.protocolVersion !== RUNTIME_PROTOCOL_VERSION ||
    typeof value.invocationId !== "string" ||
    !Array.isArray(value.events) ||
    !value.events.every(isRuntimeEvent) ||
    typeof value.done !== "boolean"
  ) {
    throw new Error("Deployment runtime returned invalid invocation events");
  }
  return {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    invocationId: value.invocationId,
    events: value.events,
    done: value.done,
  };
}

async function reportEvents(args: {
  sink: RuntimeInvocationEventSink;
  runtimeId: string;
  invocationId: string;
  events: readonly RuntimeInvocationEvent[];
  cursor: { sequence: number };
}): Promise<void> {
  if (args.events.length === 0) return;
  try {
    await args.sink.report({
      runtimeId: args.runtimeId,
      invocationId: args.invocationId,
      events: args.events,
    });
  } catch (error) {
    if (error instanceof RuntimeEventReportingError) throw error;
    throw new RuntimeEventReportingError({
      invocationId: args.invocationId,
      cause: error,
    });
  }
  args.cursor.sequence = Math.max(
    args.cursor.sequence,
    ...args.events.map((event) => event.sequence),
  );
}

function parseReceipt(args: {
  runtimeId: string;
  value: unknown;
}): RuntimeInvocationReceipt {
  if (!isRecord(args.value)) {
    throw new Error("Deployment runtime returned a non-object receipt");
  }
  if (!isReceiptValue(args.value)) {
    throw new Error("Deployment runtime returned an invalid receipt");
  }
  return {
    runtimeId: args.runtimeId,
    invocationId: args.value.invocationId,
    events: args.value.events,
    terminal: args.value.terminal,
  };
}

function parseHealth(
  value: unknown,
): Omit<RuntimeHealth, "runtimeId" | "runtimeStatus"> {
  if (
    !isRecord(value) ||
    value.protocolVersion !== RUNTIME_PROTOCOL_VERSION ||
    value.status !== "healthy" ||
    typeof value.activeInvocations !== "number" ||
    typeof value.queuedInvocations !== "number" ||
    typeof value.maxConcurrency !== "number"
  ) {
    throw new Error("Deployment runtime returned an invalid health response");
  }
  return {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    status: "healthy",
    activeInvocations: value.activeInvocations,
    queuedInvocations: value.queuedInvocations,
    maxConcurrency: value.maxConcurrency,
  };
}

function isReceiptValue(value: Record<string, unknown>): value is {
  invocationId: string;
  events: RuntimeInvocationEvent[];
  terminal: RuntimeTerminalResult;
} {
  return (
    value.protocolVersion === RUNTIME_PROTOCOL_VERSION &&
    typeof value.invocationId === "string" &&
    Array.isArray(value.events) &&
    value.events.every(isRuntimeEvent) &&
    isRuntimeTerminal(value.terminal)
  );
}

function isRuntimeEvent(value: unknown): value is RuntimeInvocationEvent {
  if (
    !isRecord(value) ||
    typeof value.invocationId !== "string" ||
    !Number.isInteger(value.sequence) ||
    Number(value.sequence) < 1 ||
    !Number.isInteger(value.attempt) ||
    Number(value.attempt) < 1 ||
    typeof value.timestamp !== "string" ||
    Number.isNaN(Date.parse(value.timestamp)) ||
    typeof value.type !== "string"
  ) {
    return false;
  }
  if (
    value.type === "accepted" ||
    value.type === "started" ||
    value.type === "completed"
  ) {
    return true;
  }
  if (
    value.type === "step_started" ||
    value.type === "step_completed" ||
    value.type === "step_failed"
  ) {
    return (
      typeof value.nodeId === "string" &&
      Number.isInteger(value.occurrence) &&
      Number(value.occurrence) >= 0 &&
      typeof value.name === "string" &&
      (value.type !== "step_failed" || typeof value.error === "string")
    );
  }
  if (value.type === "suspended") return isRecord(value.suspension);
  if (value.type === "skipped") return typeof value.reason === "string";
  if (value.type === "rate_limited") {
    return (
      typeof value.error === "string" && typeof value.retryAfterMs === "number"
    );
  }
  return (
    (value.type === "failed" ||
      value.type === "canceled" ||
      value.type === "timed_out") &&
    typeof value.error === "string"
  );
}

function isRuntimeTerminal(value: unknown): value is RuntimeTerminalResult {
  if (!isRecord(value) || !Array.isArray(value.steps)) return false;
  if (!value.steps.every(isRuntimeStep)) return false;
  if (value.status === "completed") return true;
  if (value.status === "suspended") return isRecord(value.suspension);
  if (value.status === "skipped") return typeof value.reason === "string";
  if (value.status === "rate_limited") {
    return (
      typeof value.error === "string" && typeof value.retryAfterMs === "number"
    );
  }
  return (
    (value.status === "failed" ||
      value.status === "canceled" ||
      value.status === "timed_out") &&
    typeof value.error === "string"
  );
}

function isRuntimeStep(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.nodeId === "string" &&
    typeof value.occurrence === "number" &&
    typeof value.name === "string" &&
    (value.status === "completed" || value.status === "failed") &&
    typeof value.attempt === "number" &&
    typeof value.startedAt === "string" &&
    typeof value.completedAt === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function delay(args: { milliseconds: number }): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, args.milliseconds));
}
