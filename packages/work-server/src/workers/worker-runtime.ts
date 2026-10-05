import { randomBytes } from "node:crypto";
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
  resolveExecutionSettings,
  type WorkExecutionSettings,
  workExecution,
} from "../execution-config.js";
import { signInCapabilities } from "./sign-ins.js";
import { startVolumePruning } from "./volume-pruning.js";
import {
  upgradeMessage,
  WORKER_PROTOCOL,
  WORKER_PROTOCOL_HEADER,
} from "./worker-protocol.js";
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
  /**
   * The protocol this worker states on every call (ADR 0198); the one it
   * speaks by default. Tests state another to see the control plane refuse.
   */
  protocol?: number;
  fetch?: Fetch;
  log?: (line: string) => void;
}

/** How often the worker looks for sign-ins made or removed on it. */
const SIGN_IN_SCAN_MS = 5_000;
/** How long a worker the control plane cannot drive waits to ask again. */
const UPGRADE_RETRY_MS = 5 * 60_000;

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
 * It owns its node lease (ADR 0192): the lease token is an epoch this
 * process chooses once at start, so any replica can serve any of its calls
 * and reconnecting never interrupts running work.
 */
export async function startWorkWorker(options: WorkWorkerOptions): Promise<{
  nodeId: string;
  stop(): Promise<void>;
}> {
  const base = options.controlPlaneUrl.replace(/\/+$/, "");
  if (!isSecurePublicUrl(base)) {
    throw new Error("WORK_CONTROL_PLANE_URL must use HTTPS except on loopback");
  }
  const protocol = options.protocol ?? WORKER_PROTOCOL.server;
  const baseFetch = options.fetch ?? ((input, init) => fetch(input, init));
  // Every call states the protocol this worker speaks.
  const doFetch: Fetch = (input, init) =>
    baseFetch(input, {
      ...init,
      headers: {
        ...Object.fromEntries(new Headers(init?.headers).entries()),
        [WORKER_PROTOCOL_HEADER]: String(protocol),
      },
    });
  const log = options.log ?? (() => {});
  fs.mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
  const credential = await loadOrEnroll({
    base,
    dataDir: options.dataDir,
    ...(options.enrollmentCode ? { code: options.enrollmentCode } : {}),
    fetch: doFetch,
    protocol,
  });
  const nodeId = credential.split(":")[0] ?? "";
  const resolved = await resolveExecutionSettings({
    settings: options.execution,
  });
  log(`Sandboxes: ${resolved.backend} (${resolved.reason})`);
  const execution = workExecution({
    settings: resolved,
    dataDir: options.dataDir,
    log,
  });
  const provider: SandboxProvider = execution.provider;
  // Volumes nobody used for long leave the machine (ADR 0207).
  const stopPruning = startVolumePruning({
    provider,
    retentionMs: execution.volumeRetentionMs,
    log,
  });
  /**
   * What this worker offers, read again for every connect: members'
   * sign-ins come and go on the machine (ADR 0199), and only the fact that
   * one exists is reported.
   */
  const currentOffer = (): WorkerOffer => ({
    isolation: execution.isolation,
    resourceLimits: [...(provider.resourceLimits ?? [])],
    workspaceRoot: provider.workspaceRoot ?? "/workspace",
    processes: Boolean(provider.processes),
    capabilities: [
      ...(provider.capabilities ?? []),
      ...execution.machineCapabilities,
      ...signInCapabilities(execution.signInRoot),
    ],
    capacity: execution.capacity,
    defaults: execution.defaults,
    ...(options.version ? { version: options.version } : {}),
    backend: execution.backend,
  });
  // This process's epoch: the node's lease token while it runs. A restart
  // chooses a later one, and the control plane fails what the old one was
  // sent as uncertain.
  const epoch = uuidV7();
  // Whether this epoch has held the lease: only then does being superseded
  // mean a newer process took over. Refused before that, this process may
  // be the newer one behind a clock that went back; it waits for the lease.
  let connectedOnce = false;
  /**
   * One call to the control plane. Definite answers become the runner's
   * errors; anything else (no answer, a timeout, a 5xx from a load balancer
   * or a restarting instance) is transient and retried by the caller.
   */
  const call = async ({
    route,
    body,
    signal,
  }: {
    route: "connect" | "poll" | "renew" | "complete";
    body: unknown;
    signal?: AbortSignal;
  }): Promise<unknown> => {
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
    if (response.status === 426)
      throw new WorkerUpgradeRequiredError(upgradeAnswer({ answer, protocol }));
    if (response.status === 403) throw new WorkerRefusedError(reason);
    if (
      response.status === 409 &&
      typeof answer === "object" &&
      answer !== null &&
      "superseded" in answer &&
      answer.superseded === true
    )
      throw new WorkerSupersededError(reason);
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
  const stopping = new AbortController();
  /** Resolves after `ms`, or at once when the worker stops. */
  const pause = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      stopping.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  let lastRetryLog = 0;
  let backoffMs = 1_000;

  /**
   * One session under this process's epoch, until the control plane ends
   * it. Connecting again with the same epoch keeps everything running.
   */
  const session = async (): Promise<void> => {
    let offer = currentOffer();
    await call({
      route: "connect",
      body: { session: epoch, offer },
      signal: stopping.signal,
    });
    connectedOnce = true;
    const token = epoch;
    log(`Connected to ${base} as ${nodeId}`);
    backoffMs = 1_000;
    let failure: unknown;
    let endSession: () => void = () => {};
    const ended = new Promise<void>((resolve) => {
      endSession = resolve;
      stopping.signal.addEventListener("abort", () => resolve(), {
        once: true,
      });
    });
    const transport: ClientRunnerTransport = {
      renew: async () => {
        await call({ route: "renew", body: { session: token } });
      },
      poll: async ({ pollId, max, signal }) => {
        const polled = await call({
          route: "poll",
          body: { session: token, pollId, max },
          signal,
        });
        const jobs =
          typeof polled === "object" &&
          polled !== null &&
          "jobs" in polled &&
          Array.isArray(polled.jobs)
            ? polled.jobs
            : [];
        return jobs.flatMap((job: unknown) =>
          typeof job === "object" &&
          job !== null &&
          "id" in job &&
          typeof job.id === "string" &&
          "operation" in job
            ? [{ id: job.id, operation: job.operation }]
            : [],
        );
      },
      complete: async (receipt) => {
        await call({
          route: "complete",
          body: { session: token, ...receipt },
        });
      },
      disconnect: async () => {},
    };
    const runner = startClientRunner({
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
        endSession();
      },
    });
    // A sign-in made or removed on this machine reaches placement within
    // seconds: connecting again under the same epoch refreshes the offer
    // and keeps everything running.
    const scan = setInterval(() => {
      const next = currentOffer();
      if (
        JSON.stringify(next.capabilities) === JSON.stringify(offer.capabilities)
      )
        return;
      void call({ route: "connect", body: { session: token, offer: next } })
        .then(() => {
          offer = next;
          log("Sign-ins on this machine changed; the control plane knows");
        })
        .catch(() => {
          /* Tried again on the next scan. */
        });
    }, SIGN_IN_SCAN_MS);
    await ended;
    clearInterval(scan);
    await runner.stop();
    if (failure) throw failure;
  };

  const loop = (async () => {
    while (!stopping.signal.aborted) {
      try {
        await session();
      } catch (error) {
        if (stopping.signal.aborted) break;
        if (
          error instanceof WorkerRevokedError ||
          (error instanceof WorkerSupersededError && connectedOnce)
        ) {
          log(error.message);
          break;
        }
        if (error instanceof WorkerUpgradeRequiredError) {
          // The control plane cannot drive this worker; asking every few
          // seconds would not change that.
          log(error.message);
          await pause(UPGRADE_RETRY_MS);
          continue;
        }
        if (error instanceof WorkerSupersededError) {
          log(
            "Another process of this worker holds its lease; connecting once it lapses",
          );
          await pause(5_000);
          continue;
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
      await pause(backoffMs);
      backoffMs = Math.min(backoffMs * 2, 30_000);
    }
  })();

  return {
    nodeId,
    stop: async () => {
      stopping.abort();
      stopPruning();
      await loop;
      await Promise.allSettled(
        [...sandboxes].map((id) => provider.stopSandbox(id)),
      );
    },
  };
}

/**
 * A UUIDv7: the millisecond clock, then random bits. A later process's
 * epoch sorts after an earlier one's (ADR 0192).
 */
function uuidV7(): string {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(Date.now(), 0, 6);
  bytes.writeUInt8(((bytes.readUInt8(6) & 0x0f) | 0x70) >>> 0, 6);
  bytes.writeUInt8(((bytes.readUInt8(8) & 0x3f) | 0x80) >>> 0, 8);
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function loadOrEnroll(args: {
  base: string;
  dataDir: string;
  code?: string;
  fetch: Fetch;
  protocol: number;
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
  if (response.status === 426)
    throw new WorkerUpgradeRequiredError(
      upgradeAnswer({ answer: body, protocol: args.protocol }),
    );
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

/** The control plane's 426: which side to update, in words. */
function upgradeAnswer(input: { answer: unknown; protocol: number }): string {
  const { answer } = input;
  const number = (key: string): number | undefined =>
    typeof answer === "object" &&
    answer !== null &&
    key in answer &&
    typeof Reflect.get(answer, key) === "number"
      ? Number(Reflect.get(answer, key))
      : undefined;
  const serverProtocol = number("serverProtocol");
  const minimum = number("minimum");
  if (serverProtocol === undefined || minimum === undefined)
    return "The control plane cannot drive this worker's protocol: update the worker or the control plane so they match.";
  return upgradeMessage({ own: input.protocol, serverProtocol, minimum });
}

/**
 * The control plane cannot drive this worker's protocol (426, ADR 0198):
 * one of them must be updated.
 */
export class WorkerUpgradeRequiredError extends RunnerSessionEndedError {
  constructor(message: string) {
    super(message);
    this.name = "WorkerUpgradeRequiredError";
  }
}

/** The operator's placement forbids this worker as it runs. */
class WorkerRefusedError extends RunnerSessionEndedError {
  constructor(message: string) {
    super(message);
    this.name = "WorkerRefusedError";
  }
}

/**
 * A newer process of this worker connected (ADR 0192): this one stops for
 * good, since connecting again would take the lease back from it.
 */
class WorkerSupersededError extends RunnerSessionEndedError {
  constructor(message: string) {
    super(message);
    this.name = "WorkerSupersededError";
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
