import fs from "node:fs";
import path from "node:path";
import type { SandboxProvider } from "@catamorphic/sandbox";
import {
  type ClientRunnerTransport,
  ReceiptRefusedError,
  ResultRejectedError,
  RunnerSessionEndedError,
  startClientRunner,
} from "@catamorphic/server-sdk";
import { isSecurePublicUrl } from "../config.js";
import {
  type WorkExecutionSettings,
  workExecution,
} from "../execution-config.js";
import type { WorkerOffer } from "./worker-registry.js";

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface WorkWorkerOptions {
  /** The control plane's public origin, e.g. `https://brain.example.com`. */
  controlPlaneUrl: string;
  /** Owner-only local state: the machine credential and sandboxes. */
  dataDir: string;
  /** One-time code from `POST /_work/operator/workers`; first start only. */
  enrollmentCode?: string;
  execution: WorkExecutionSettings;
  version?: string;
  fetch?: Fetch;
  log?: (line: string) => void;
}

/**
 * How long each call may take. A poll waits up to 20 seconds on the control
 * plane; a receipt may carry up to 64 MiB.
 */
const CALL_TIMEOUT_MS = {
  connect: 60_000,
  poll: 45_000,
  renew: 30_000,
  complete: 300_000,
} as const;

/**
 * A remote worker (ADR 0164): runs sandbox operations for agents whose
 * controller loops run on the control plane. It holds only its own machine
 * credential, never database access, vault keys, or member tokens, and it
 * reaches the control plane over outbound HTTPS, so it needs no open port.
 */
export async function startWorkWorker(options: WorkWorkerOptions): Promise<{
  nodeId: string;
  stop(): Promise<void>;
}> {
  const base = options.controlPlaneUrl.replace(/\/+$/, "");
  if (!isSecurePublicUrl(base)) {
    throw new Error("WORK_CONTROL_PLANE_URL must use HTTPS except on loopback");
  }
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
  const log = options.log ?? (() => {});
  fs.mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
  const credential = await loadOrEnroll({
    base,
    dataDir: options.dataDir,
    ...(options.enrollmentCode ? { code: options.enrollmentCode } : {}),
    fetch: doFetch,
  });
  const nodeId = credential.split(":")[0] ?? "";
  const execution = workExecution({
    settings: options.execution,
    dataDir: options.dataDir,
  });
  const provider: SandboxProvider = execution.provider;
  const offer: WorkerOffer = {
    isolation: execution.isolation,
    resourceLimits: [...(provider.resourceLimits ?? [])],
    workspaceRoot: provider.workspaceRoot ?? "/workspace",
    processes: Boolean(provider.processes),
    capabilities: [
      ...(provider.capabilities ?? []),
      ...execution.machineCapabilities,
    ],
    capacity: execution.capacity,
    defaults: execution.defaults,
    ...(options.version ? { version: options.version } : {}),
  };
  /**
   * One call to the control plane. Definite answers become the runner's
   * errors; anything else (no answer, a timeout, a 5xx from a load balancer
   * or a restarting instance) is transient and retried by the caller.
   */
  const call = async (
    route: "connect" | "poll" | "renew" | "complete",
    body: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> => {
    const timeout = AbortSignal.timeout(CALL_TIMEOUT_MS[route]);
    const response = await doFetch(`${base}/api/workers/${route}`, {
      method: "POST",
      headers: {
        authorization: `Worker ${credential}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (response.ok) return response.json();
    const answer: unknown = await response.json().catch(() => undefined);
    const reason =
      typeof answer === "object" &&
      answer !== null &&
      "error" in answer &&
      typeof answer.error === "string"
        ? answer.error
        : `Control plane answered ${response.status} on ${route}`;
    if (response.status === 401) throw new WorkerRevokedError();
    if (response.status === 403) throw new WorkerRefusedError(reason);
    if (route === "complete" && response.status === 409)
      throw new ReceiptRefusedError(reason);
    if (route === "complete" && [400, 413].includes(response.status))
      throw new ResultRejectedError(reason);
    if (response.status >= 500 || [408, 429].includes(response.status))
      throw new Error(reason);
    // The lease moved on (409), or this worker's protocol is not the
    // control plane's: connect again.
    throw new RunnerSessionEndedError(reason);
  };

  // Sandboxes belong to this worker process, across control-plane sessions.
  const sandboxes = new PersistedSandboxes(
    path.join(options.dataDir, "sandboxes.json"),
  );
  let stopped = false;
  let runner: { stop(): Promise<void> } | undefined;
  let wake: (() => void) | undefined;
  let lastRetryLog = 0;
  let backoffMs = 1_000;

  /** One session: a node lease, held until the control plane ends it. */
  const session = async (): Promise<void> => {
    const connected = await call("connect", offer);
    const token =
      typeof connected === "object" &&
      connected !== null &&
      "session" in connected &&
      typeof connected.session === "string"
        ? connected.session
        : undefined;
    if (!token) throw new Error("The control plane returned no session");
    log(`Connected to ${base} as ${nodeId}`);
    backoffMs = 1_000;
    let failure: unknown;
    const ended = new Promise<void>((resolve) => {
      wake = resolve;
    });
    const transport: ClientRunnerTransport = {
      renew: async () => {
        await call("renew", { session: token });
      },
      poll: async ({ pollId, signal }) => {
        const polled = await call("poll", { session: token, pollId }, signal);
        return typeof polled === "object" &&
          polled !== null &&
          "job" in polled &&
          typeof polled.job === "object" &&
          polled.job !== null &&
          "id" in polled.job &&
          typeof polled.job.id === "string" &&
          "operation" in polled.job
          ? { id: polled.job.id, operation: polled.job.operation }
          : null;
      },
      complete: async (receipt) => {
        await call("complete", { session: token, ...receipt });
      },
      disconnect: async () => {},
    };
    runner = startClientRunner({
      provider,
      transport,
      sandboxes,
      keepSandboxes: true,
      maxSandboxes: execution.capacity.workspaces,
      // One slot per workspace, so one long command never blocks the others.
      concurrency: Math.min(16, Math.max(1, execution.capacity.workspaces)),
      onRetry: (error) => {
        if (Date.now() - lastRetryLog < 10_000) return;
        lastRetryLog = Date.now();
        log(
          `Control plane unreachable, retrying: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      },
      onError: (error) => {
        failure = error;
        wake?.();
      },
    });
    await ended;
    const current = runner;
    runner = undefined;
    await current?.stop();
    if (failure) throw failure;
  };

  const loop = (async () => {
    while (!stopped) {
      try {
        await session();
      } catch (error) {
        if (error instanceof WorkerRevokedError) {
          log(error.message);
          stopped = true;
          break;
        }
        log(
          error instanceof WorkerRefusedError
            ? // Reachable, but the operator's placement forbids this worker
              // as it runs; it connects once that changes.
              `The control plane refused this worker: ${error.message}`
            : error instanceof RunnerSessionEndedError
              ? `Worker session ended: ${error.message}`
              : `Worker cannot reach the control plane: ${
                  error instanceof Error ? error.message : String(error)
                }`,
        );
      }
      if (stopped) break;
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
      backoffMs = Math.min(backoffMs * 2, 30_000);
    }
  })();

  return {
    nodeId,
    stop: async () => {
      stopped = true;
      wake?.();
      await runner?.stop();
      await loop;
      await Promise.allSettled(
        [...sandboxes].map((id) => provider.stopSandbox(id)),
      );
    },
  };
}

async function loadOrEnroll(args: {
  base: string;
  dataDir: string;
  code?: string;
  fetch: Fetch;
}): Promise<string> {
  const file = path.join(args.dataDir, "worker-credential");
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (existing) return existing;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw error;
  }
  if (!args.code) {
    throw new Error(
      "This worker is not enrolled. Set WORK_WORKER_ENROLLMENT to a code from the control plane operator.",
    );
  }
  const response = await args.fetch(`${args.base}/api/workers/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: args.code }),
  });
  const body: unknown = await response.json().catch(() => ({}));
  const credential =
    typeof body === "object" &&
    body !== null &&
    "credential" in body &&
    typeof body.credential === "string"
      ? body.credential
      : undefined;
  if (!response.ok || !credential) {
    const message =
      typeof body === "object" &&
      body !== null &&
      "error" in body &&
      typeof body.error === "string"
        ? body.error
        : `HTTP ${response.status}`;
    throw new Error(`Enrollment failed: ${message}`);
  }
  fs.writeFileSync(file, `${credential}\n`, { mode: 0o600, flag: "wx" });
  return credential;
}

/** The operator's placement forbids this worker as it runs. */
class WorkerRefusedError extends RunnerSessionEndedError {
  constructor(message: string) {
    super(message);
    this.name = "WorkerRefusedError";
  }
}

/** The operator revoked this worker; it never connects again. */
class WorkerRevokedError extends RunnerSessionEndedError {
  constructor() {
    super("This worker's credential was revoked or is unknown");
    this.name = "WorkerRevokedError";
  }
}

/**
 * The sandboxes this worker owns, kept across restarts and upgrades so live
 * sessions keep their workspaces and ended ones can still be cleaned up.
 */
class PersistedSandboxes extends Set<string> {
  private ready = false;

  constructor(private readonly file: string) {
    super();
    try {
      const stored: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
      if (Array.isArray(stored))
        for (const id of stored) if (typeof id === "string") super.add(id);
    } catch {
      /* No record yet. */
    }
    this.ready = true;
  }

  override add(id: string): this {
    super.add(id);
    this.save();
    return this;
  }

  override delete(id: string): boolean {
    const removed = super.delete(id);
    if (removed) this.save();
    return removed;
  }

  private save() {
    if (!this.ready) return;
    fs.writeFileSync(this.file, JSON.stringify([...this]), { mode: 0o600 });
  }
}
