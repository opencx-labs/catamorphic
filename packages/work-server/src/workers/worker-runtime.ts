import fs from "node:fs";
import path from "node:path";
import type { SandboxProvider } from "@catamorphic/sandbox";
import {
  type ClientRunnerTransport,
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

class SessionEndedError extends Error {}

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
    capacity: execution.capacity,
    defaults: execution.defaults,
    ...(options.version ? { version: options.version } : {}),
  };
  const call = async (route: string, body: unknown): Promise<unknown> => {
    const response = await doFetch(`${base}/api/workers/${route}`, {
      method: "POST",
      headers: {
        authorization: `Worker ${credential}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (response.status === 401) {
      throw new Error("This worker's credential was revoked or is unknown");
    }
    if (response.status === 409) throw new SessionEndedError();
    if (!response.ok) {
      const body: unknown = await response.json().catch(() => undefined);
      const reason =
        typeof body === "object" &&
        body !== null &&
        "error" in body &&
        typeof body.error === "string"
          ? `: ${body.error}`
          : "";
      if (response.status === 403) {
        throw new WorkerRefusedError(reason.slice(2) || "Refused");
      }
      throw new Error(
        `Control plane answered ${response.status} on ${route}${reason}`,
      );
    }
    return response.json();
  };

  // Sandboxes belong to this worker process, across control-plane sessions.
  const sandboxes = new PersistedSandboxes(
    path.join(options.dataDir, "sandboxes.json"),
  );
  let stopped = false;
  let runners: Array<{ stop(): Promise<void> }> = [];
  let wake: (() => void) | undefined;

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
    const ended = new Promise<void>((resolve) => {
      wake = resolve;
    });
    const transport: ClientRunnerTransport = {
      renew: async () => {
        await call("renew", { session: token });
      },
      poll: async () => {
        const polled = await call("poll", { session: token });
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
    // One lane per workspace so one long command never blocks the others.
    const lanes = Math.min(16, Math.max(1, execution.capacity.workspaces));
    runners = Array.from({ length: lanes }, () =>
      startClientRunner({
        provider,
        transport,
        sandboxes,
        keepSandboxes: true,
        maxSandboxes: execution.capacity.workspaces,
        idleDelayMs: 0,
        onError: (error) => {
          if (!(error instanceof SessionEndedError)) {
            log(
              `Worker session ended: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
          wake?.();
        },
      }),
    );
    await ended;
    const current = runners;
    runners = [];
    await Promise.allSettled(current.map((runner) => runner.stop()));
  };

  const loop = (async () => {
    let backoffMs = 1_000;
    while (!stopped) {
      try {
        await session();
        backoffMs = 1_000;
      } catch (error) {
        if (error instanceof WorkerRefusedError) {
          // Reachable, but the operator's placement forbids this worker as it
          // runs; it connects once that changes.
          log(`The control plane refused this worker: ${error.message}`);
        } else if (!(error instanceof SessionEndedError)) {
          log(
            `Worker cannot reach the control plane: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          if (error instanceof Error && /revoked/.test(error.message)) {
            stopped = true;
            break;
          }
        }
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

class WorkerRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerRefusedError";
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
