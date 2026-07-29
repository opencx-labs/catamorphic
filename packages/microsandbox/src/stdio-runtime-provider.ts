import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import type {
  RuntimeInvocationEvent,
  RuntimeSupervisorHealth,
} from "@catamorphic/runtime";
import { RUNTIME_PROTOCOL_VERSION } from "@catamorphic/runtime";
import type {
  CancelRuntimeInvocationArgs,
  DeploymentRuntime,
  DeploymentRuntimeProvider,
  EnsureDeploymentRuntimeArgs,
  RuntimeHealth,
  RuntimeInvocation,
  RuntimeInvocationReceipt,
} from "@catamorphic/sandbox";
import {
  RuntimeEventReportingError,
  RuntimeInfrastructureError,
} from "@catamorphic/sandbox";
import type { ExecHandle, ExecSink, Sandbox } from "microsandbox";

const READY_TIMEOUT_MS = 15_000;

interface PendingRequest {
  resolve: (body: unknown) => void;
  reject: (error: unknown) => void;
}

interface EventSubscription {
  onEvents: (events: readonly RuntimeInvocationEvent[]) => void;
}

/**
 * One live supervisor channel: a `bun run entry.mjs` exec stream whose
 * stdin/stdout carry JSON-lines frames. Stdout is reserved for frames
 * (workflow output goes to stderr and lands in the sandbox's exec log).
 */
class SupervisorChannel {
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly subscriptions = new Map<string, EventSubscription>();
  private buffer = "";
  private closed: Error | undefined;

  private constructor(
    private readonly handle: ExecHandle,
    private readonly stdin: ExecSink,
  ) {}

  static async open(args: {
    sandbox: Sandbox;
    runtimeDirectory: string;
    env: Record<string, string>;
  }): Promise<SupervisorChannel> {
    const handle = await args.sandbox.execStreamWith("bun", (exec) =>
      exec
        .args(["run", "entry.mjs"])
        .cwd(args.runtimeDirectory)
        .envs(args.env)
        .stdinPipe(),
    );
    const stdin = await handle.takeStdin();
    if (!stdin) {
      await handle.kill().catch(() => {});
      throw new Error("Supervisor exec stream has no stdin sink");
    }
    const channel = new SupervisorChannel(handle, stdin);
    const ready = channel.waitForReady();
    channel.consume();
    try {
      await ready;
    } catch (error) {
      await channel.shutdown();
      throw error;
    }
    return channel;
  }

  private waitForReady(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              `Supervisor did not report ready within ${READY_TIMEOUT_MS}ms`,
            ),
          ),
        READY_TIMEOUT_MS,
      );
      this.onReady = () => {
        clearTimeout(timer);
        this.onReady = undefined;
        resolve();
      };
      this.onClosed = (error) => {
        clearTimeout(timer);
        reject(error);
      };
    });
  }

  private onReady: (() => void) | undefined;
  private onClosed: ((error: Error) => void) | undefined;

  private consume(): void {
    void (async () => {
      const decoder = new TextDecoder();
      try {
        for await (const event of this.handle) {
          if (event.kind === "stdout") {
            this.buffer += decoder.decode(event.data, { stream: true });
            this.drainLines();
          }
          if (event.kind === "exited") break;
        }
        this.close(new Error("Supervisor stream ended"));
      } catch (error) {
        this.close(
          error instanceof Error
            ? error
            : new Error(`Supervisor stream failed: ${String(error)}`),
        );
      }
    })();
  }

  private drainLines(): void {
    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      newline = this.buffer.indexOf("\n");
      if (line !== "") this.dispatch(line);
    }
  }

  private dispatch(line: string): void {
    let frame: unknown;
    try {
      frame = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(frame)) return;
    if (frame.kind === "ready") {
      if (frame.protocolVersion !== RUNTIME_PROTOCOL_VERSION) {
        this.close(
          new Error(
            `Supervisor protocol version mismatch: expected ${RUNTIME_PROTOCOL_VERSION}, got ${String(frame.protocolVersion)}`,
          ),
        );
        return;
      }
      this.onReady?.();
      return;
    }
    if (frame.kind === "response" && Number.isInteger(frame.id)) {
      const pending = this.pending.get(Number(frame.id));
      if (!pending) return;
      this.pending.delete(Number(frame.id));
      if (frame.ok === true) {
        pending.resolve(frame.body);
      } else {
        const error = isRecord(frame.error) ? frame.error : {};
        pending.reject(
          new Error(
            `Supervisor request failed (${String(error.code ?? "unknown")}): ${String(error.message ?? "no message")}`,
          ),
        );
      }
      return;
    }
    if (
      frame.kind === "events" &&
      typeof frame.invocationId === "string" &&
      Array.isArray(frame.events)
    ) {
      this.subscriptions
        .get(frame.invocationId)
        ?.onEvents(frame.events as RuntimeInvocationEvent[]);
    }
  }

  request(op: "health"): Promise<unknown>;
  request(op: "invoke", payload: { request: unknown }): Promise<unknown>;
  request(op: "cancel", payload: { invocationId: string }): Promise<unknown>;
  request(op: string, payload?: Record<string, unknown>): Promise<unknown> {
    if (this.closed) return Promise.reject(this.closed);
    const id = this.nextId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    void this.stdin
      .write(`${JSON.stringify({ id, op, ...payload })}\n`)
      .catch((error: unknown) => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        pending.reject(error);
      });
    return promise;
  }

  subscribe(
    invocationId: string,
    onEvents: (events: readonly RuntimeInvocationEvent[]) => void,
  ): () => void {
    this.subscriptions.set(invocationId, { onEvents });
    return () => this.subscriptions.delete(invocationId);
  }

  get isClosed(): boolean {
    return this.closed !== undefined;
  }

  private close(error: Error): void {
    if (this.closed) return;
    this.closed = error;
    this.onClosed?.(error);
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.subscriptions.clear();
  }

  async shutdown(): Promise<void> {
    this.close(new Error("Supervisor channel was shut down"));
    await this.handle.kill().catch(() => {});
  }
}

interface RuntimeRecord {
  runtime: DeploymentRuntime;
  channel: SupervisorChannel;
}

export interface StdioDeploymentRuntimeProviderOptions {
  connect: (sandboxId: string) => Promise<Sandbox>;
  uploadFiles: (
    sandboxId: string,
    files: Record<string, string>,
    basePath: string,
  ) => Promise<void>;
}

/**
 * Deployment runtimes over the sandbox's native exec-stream channel instead
 * of HTTP: no published ports, no bearer tokens, no per-poll process spawns.
 * Events arrive as pushed frames the moment the dispatcher emits them.
 */
export class StdioDeploymentRuntimeProvider
  implements DeploymentRuntimeProvider
{
  private readonly runtimes = new Map<string, RuntimeRecord>();
  private readonly runtimeKeys = new Map<string, string>();

  constructor(
    private readonly options: StdioDeploymentRuntimeProviderOptions,
  ) {}

  async ensureRuntime(
    args: EnsureDeploymentRuntimeArgs,
  ): Promise<DeploymentRuntime> {
    const key = runtimeKey(args);
    const existingId = this.runtimeKeys.get(key);
    const existing = existingId ? this.runtimes.get(existingId) : undefined;
    if (existing && !existing.channel.isClosed) return existing.runtime;

    const runtimeId = `runtime-${crypto.randomUUID()}`;
    const runtimeDirectory = `${args.workingDirectory}/../runtime`;
    const writableRoot = `${args.workingDirectory}/../runs`;
    const files = await loadSupervisorFiles();
    await this.options.uploadFiles(args.sandboxId, files, runtimeDirectory);
    const sandbox = await this.options.connect(args.sandboxId);
    await sandbox.shell(`mkdir -p '${writableRoot.replaceAll("'", `'\\''`)}'`);
    const channel = await SupervisorChannel.open({
      sandbox,
      runtimeDirectory,
      env: {
        ...(args.env ?? {}),
        CATAMORPHIC_RUNTIME_ARTIFACT_ROOT: args.workingDirectory,
        CATAMORPHIC_RUNTIME_WRITABLE_ROOT: writableRoot,
        CATAMORPHIC_DEPLOYMENT_ARTIFACT_ID: args.deploymentArtifactId,
        CATAMORPHIC_ARTIFACT_DIGEST: args.artifactDigest,
        CATAMORPHIC_TRANSFORM_VERSION: args.transformVersion,
        CATAMORPHIC_RUNTIME_VERSION: args.runtimeVersion,
        CATAMORPHIC_RUNTIME_MAX_CONCURRENCY: String(args.maxConcurrency ?? 4),
      },
    });

    const runtime: DeploymentRuntime = {
      runtimeId,
      sandboxId: args.sandboxId,
      deploymentArtifactId: args.deploymentArtifactId,
      artifactDigest: args.artifactDigest,
      transformVersion: args.transformVersion,
      runtimeVersion: args.runtimeVersion,
      generation: crypto.randomUUID(),
      status: "healthy",
    };
    this.runtimes.set(runtimeId, { runtime, channel });
    this.runtimeKeys.set(key, runtimeId);
    return runtime;
  }

  async invoke(args: RuntimeInvocation): Promise<RuntimeInvocationReceipt> {
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

    const cursor = { sequence: 0 };
    // Event batches must reach the sink in order; each report chains on the
    // previous one, and a failure surfaces before the receipt is returned.
    let reporting: Promise<void> = Promise.resolve();
    const sink = args.eventSink;
    const unsubscribe = sink
      ? record.channel.subscribe(args.invocationId, (events) => {
          const fresh = events.filter(
            (event) => event.sequence > cursor.sequence,
          );
          if (fresh.length === 0) return;
          cursor.sequence = Math.max(...fresh.map((event) => event.sequence));
          reporting = reporting.then(() =>
            sink
              .report({
                runtimeId: args.runtimeId,
                invocationId: args.invocationId,
                events: fresh,
              })
              .then(() => {}),
          );
        })
      : undefined;

    const cancelInvocation = (): void => {
      void this.cancel({
        runtimeId: args.runtimeId,
        invocationId: args.invocationId,
      }).catch(() => {});
    };
    args.signal?.addEventListener("abort", cancelInvocation, { once: true });

    try {
      const body = await record.channel.request("invoke", {
        request: invocationRequestPayload(args),
      });
      const receipt = parseReceipt({ runtimeId: args.runtimeId, value: body });
      if (sink) {
        const fresh = receipt.events.filter(
          (event) => event.sequence > cursor.sequence,
        );
        if (fresh.length > 0) {
          cursor.sequence = Math.max(...fresh.map((event) => event.sequence));
          reporting = reporting.then(() =>
            sink
              .report({
                runtimeId: args.runtimeId,
                invocationId: args.invocationId,
                events: fresh,
              })
              .then(() => {}),
          );
        }
        try {
          await reporting;
        } catch (error) {
          if (error instanceof RuntimeEventReportingError) throw error;
          throw new RuntimeEventReportingError({
            invocationId: args.invocationId,
            cause: error,
          });
        }
      }
      return receipt;
    } catch (error) {
      // The reporting chain may already hold a rejection that will never be
      // awaited on this path; observe it so it cannot surface as an
      // unhandled rejection.
      void reporting.catch(() => {});
      if (args.signal?.aborted) throw error;
      if (
        error instanceof RuntimeInfrastructureError ||
        error instanceof RuntimeEventReportingError
      ) {
        throw error;
      }
      throw new RuntimeInfrastructureError({
        operation: `invocation '${args.invocationId}' handoff`,
        cause: error,
      });
    } finally {
      unsubscribe?.();
      args.signal?.removeEventListener("abort", cancelInvocation);
    }
  }

  async cancel(args: CancelRuntimeInvocationArgs): Promise<void> {
    const record = this.requireRuntime(args.runtimeId);
    await record.channel.request("cancel", {
      invocationId: args.invocationId,
    });
  }

  async getHealth(args: { runtimeId: string }): Promise<RuntimeHealth> {
    const record = this.requireRuntime(args.runtimeId);
    if (record.channel.isClosed) {
      return unhealthy(args.runtimeId);
    }
    try {
      const body = await record.channel.request("health");
      return {
        runtimeId: args.runtimeId,
        runtimeStatus: "healthy",
        ...parseHealth(body),
      };
    } catch {
      return unhealthy(args.runtimeId);
    }
  }

  async shutdown(): Promise<void> {
    await Promise.all(
      [...this.runtimes.values()].map((record) => record.channel.shutdown()),
    );
    this.runtimes.clear();
    this.runtimeKeys.clear();
  }

  private requireRuntime(runtimeId: string): RuntimeRecord {
    const record = this.runtimes.get(runtimeId);
    if (!record) throw new Error(`Deployment runtime '${runtimeId}' not found`);
    return record;
  }
}

function invocationRequestPayload(args: RuntimeInvocation): unknown {
  return {
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
  };
}

function unhealthy(runtimeId: string): RuntimeHealth {
  return {
    runtimeId,
    runtimeStatus: "error",
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    status: "healthy",
    activeInvocations: 0,
    queuedInvocations: 0,
    maxConcurrency: 0,
  };
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
  startStdioSupervisor,
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
    childStdout: "stderr",
  }),
});
startStdioSupervisor({ dispatcher });
// Keep the process alive on a resumable stdin even when no frames are pending.
process.stdin.resume();
`;
}

function parseReceipt(args: {
  runtimeId: string;
  value: unknown;
}): RuntimeInvocationReceipt {
  const value = args.value;
  if (
    !isRecord(value) ||
    value.protocolVersion !== RUNTIME_PROTOCOL_VERSION ||
    typeof value.invocationId !== "string" ||
    !Array.isArray(value.events) ||
    !isRecord(value.terminal) ||
    typeof value.terminal.status !== "string"
  ) {
    throw new Error("Deployment runtime returned an invalid receipt");
  }
  return {
    runtimeId: args.runtimeId,
    invocationId: value.invocationId,
    events: value.events as RuntimeInvocationEvent[],
    terminal: value.terminal as RuntimeInvocationReceipt["terminal"],
  };
}

function parseHealth(value: unknown): RuntimeSupervisorHealth {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
