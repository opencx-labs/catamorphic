import { randomUUID } from "node:crypto";
import type { DB } from "@catamorphic/db";
import { getTracer, withSpan } from "@catamorphic/otel";
import type {
  CreateSandboxOpts,
  SandboxProvider,
  SandboxResources,
} from "@catamorphic/sandbox";
import { type Kysely, sql } from "kysely";
import type { ExecutionAllocation } from "./execution-allocations-service.js";

/**
 * The Allocation's image, containers and egress (ADR 0176) on a provider
 * that keeps its own sandbox lifecycle, such as a member's computer: the
 * Environment decides what its sandboxes boot, wherever they run.
 */
export function withAllocationSandboxPolicy(args: {
  allocation: ExecutionAllocation;
  provider: SandboxProvider;
}): SandboxProvider {
  const { provider } = args;
  const sandbox = args.allocation.policy.sandbox;
  if (!sandbox?.image && !sandbox?.containers && !sandbox?.egress)
    return provider;
  const createSandbox = (opts: CreateSandboxOpts) =>
    provider.createSandbox({
      ...opts,
      ...(sandbox.image ? { image: sandbox.image } : {}),
      ...(sandbox.containers ? { containers: true } : {}),
      ...(sandbox.egress ? { egress: sandbox.egress } : {}),
    });
  return new Proxy(provider, {
    get(target, property) {
      if (property === "createSandbox") return createSandbox;
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** One sandbox per Allocation. Never reuse another workload's filesystem or budget. */
export function allocationSandboxProvider(args: {
  db: Kysely<DB>;
  allocation: ExecutionAllocation;
  provider: SandboxProvider;
  /**
   * The lease of this process's own local node, read at each check. A
   * remote node's provider fences its own operations (ADR 0192).
   */
  workerLeaseToken?: string | (() => string | undefined);
}): SandboxProvider {
  const { db, allocation, provider } = args;
  const limits = allocation.policy.requirements.resources;
  const resources: SandboxResources = {
    cpuMillis: limits?.cpuMillis,
    memoryMb: limits?.memoryMb,
    storageMb: limits?.storageMb,
    gpu: limits?.gpu,
  };
  const requireActive = async (sandboxId?: string) => {
    const leaseToken =
      typeof args.workerLeaseToken === "function"
        ? args.workerLeaseToken()
        : args.workerLeaseToken;
    if (allocation.workerNodeId && args.workerLeaseToken) {
      if (!leaseToken)
        throw new Error("This machine no longer owns its execution lease");
      const live = await db
        .selectFrom("worker_nodes")
        .select("id")
        .where("id", "=", allocation.workerNodeId)
        .where("lease_token", "=", leaseToken)
        .where("enabled", "=", true)
        .where("lease_expires_at", ">", sql<Date>`now()`)
        .executeTakeFirst();
      if (!live)
        throw new Error("This machine no longer owns its execution lease");
    }
    const row = await db
      .selectFrom("execution_allocations")
      .selectAll()
      .where("id", "=", allocation.id)
      .where("status", "=", "active")
      .where("capacity_released_at", "is", null)
      .executeTakeFirst();
    if (!row || (sandboxId && row.sandbox_provider_id !== sandboxId)) {
      throw new Error(
        "Workspace Allocation is no longer active or does not own this sandbox",
      );
    }
    return row;
  };
  const create = async (opts: CreateSandboxOpts) => {
    const row = await requireActive();
    if (row.sandbox_provider_id) {
      await provider.startSandbox(row.sandbox_provider_id);
      return {
        id: row.sandbox_provider_id,
        providerId: row.sandbox_provider_id,
        sandboxType: "execution" as const,
        status: "started" as const,
      };
    }
    const claimed = await db
      .updateTable("execution_allocations")
      .set({ sandbox_creation_started: true })
      .where("id", "=", allocation.id)
      .where("status", "=", "active")
      .where("sandbox_creation_started", "=", false)
      .returning("id")
      .executeTakeFirst();
    if (!claimed)
      throw new Error(
        "Workspace creation is already in progress or needs operator recovery",
      );
    // Keep the reservation on an uncertain create. Lease expiry does not prove
    // that the provider failed to allocate a machine.
    // The Environment's image, containers and egress were fixed when the
    // Allocation was admitted; no caller can widen them (ADR 0176).
    const sandbox = allocation.policy.sandbox;
    const handle = await provider.createSandbox({
      ...opts,
      ...(sandbox?.image ? { image: sandbox.image } : {}),
      ...(sandbox?.containers ? { containers: true } : {}),
      ...(sandbox?.egress ? { egress: sandbox.egress } : {}),
      resources,
      labels: {
        ...opts.labels,
        allocationId: allocation.id,
        workerNodeId: allocation.workerNodeId ?? "",
      },
    });
    await db
      .updateTable("execution_allocations")
      .set({ sandbox_provider_id: handle.providerId })
      .where("id", "=", allocation.id)
      .execute();
    await requireActive(handle.providerId);
    return handle;
  };
  const guard = async <T>(id: string, action: () => Promise<T>): Promise<T> => {
    await requireActive(id);
    return action();
  };
  const runtime = provider.deploymentRuntime;
  const processes = provider.processes;
  return {
    workspaceRoot: provider.workspaceRoot,
    resourceLimits: provider.resourceLimits,
    isolation: provider.isolation,
    capabilities: provider.capabilities,
    createSandbox: create,
    startSandbox: (id) => guard(id, () => provider.startSandbox(id)),
    stopSandbox: (id) => guard(id, () => provider.stopSandbox(id)),
    // Runtime eviction stops the workspace; only Allocation cleanup destroys it.
    destroySandbox: (id) => guard(id, () => provider.stopSandbox(id)),
    getSandboxStatus: (id) => guard(id, () => provider.getSandboxStatus(id)),
    executeCommand: (id, command, opts) =>
      guard(id, () =>
        provider.executeCommand(id, command, {
          ...opts,
          ...(limits?.commandTimeoutSeconds
            ? {
                timeout: Math.min(
                  opts?.timeout ?? limits.commandTimeoutSeconds,
                  limits.commandTimeoutSeconds,
                ),
              }
            : {}),
        }),
      ),
    uploadFiles: (id, files, base) =>
      guard(id, () => provider.uploadFiles(id, files, base)),
    downloadFile: (id, file) =>
      guard(id, () => provider.downloadFile(id, file)),
    gitClone: (id, url, path, opts) =>
      guard(id, () => provider.gitClone(id, url, path, opts)),
    gitCheckout: (id, path, ref) =>
      guard(id, () => provider.gitCheckout(id, path, ref)),
    // Background processes live in the Allocation's sandbox and end with
    // it; each operation proves the Allocation still owns that sandbox.
    ...(processes
      ? {
          processes: {
            startProcess: (opts) =>
              guard(opts.sandboxId, () => processes.startProcess(opts)),
            readProcessOutput: (opts) =>
              guard(opts.sandboxId, () => processes.readProcessOutput(opts)),
            signalProcess: (opts) =>
              guard(opts.sandboxId, () => processes.signalProcess(opts)),
            listProcesses: (opts) =>
              guard(opts.sandboxId, () => processes.listProcesses(opts)),
            writeProcessInput: (opts) =>
              guard(opts.sandboxId, () => processes.writeProcessInput(opts)),
          },
        }
      : {}),
    ...(runtime
      ? {
          deploymentRuntime: {
            ensureRuntime: (opts) =>
              guard(opts.sandboxId, () =>
                runtime.ensureRuntime({
                  ...opts,
                  maxConcurrency: limits?.maxConcurrency ?? opts.maxConcurrency,
                }),
              ),
            invoke: async (opts) => {
              await requireActive();
              return runtime.invoke(opts);
            },
            cancel: (opts) => runtime.cancel(opts),
            getHealth: async (opts) => {
              await requireActive();
              return runtime.getHealth(opts);
            },
          },
        }
      : {}),
  };
}

/** A host's claim on an Allocation's maintenance (ADR 0192). */
export interface AllocationMaintenanceClaim {
  allocationId: string;
  token: string;
}

const MAINTENANCE_MINUTES = 5;

/**
 * Claim an Allocation for saving or destroying its workspace (ADR 0192), so
 * two hosts never do it at once. For an idle chat's active workspace, pass
 * its session: the claim locks the session row and is refused while the chat
 * has a queued, held, or running turn, and turns wait while it is held. The
 * claim lapses on its own if the host stops midway; {@link
 * withAllocationMaintenance} renews it while the work runs.
 */
export async function claimAllocationMaintenance(args: {
  db: Kysely<DB>;
  allocationId: string;
  status: "active" | "released";
  sessionId?: string;
}): Promise<AllocationMaintenanceClaim | undefined> {
  const token = randomUUID();
  return args.db.transaction().execute(async (trx) => {
    if (args.sessionId) {
      const session = await trx
        .selectFrom("agent_sessions")
        .select(["status", "allocation_id"])
        .where("id", "=", args.sessionId)
        .forUpdate()
        .executeTakeFirst();
      if (
        session?.status !== "active" ||
        session.allocation_id !== args.allocationId
      )
        return undefined;
      const busy = await trx
        .selectFrom("agent_turns")
        .select("id")
        .where("session_id", "=", args.sessionId)
        .where("status", "in", ["queued", "held", "running"])
        .executeTakeFirst();
      if (busy) return undefined;
    }
    const claimed = await trx
      .updateTable("execution_allocations")
      .set({
        maintenance_claim: token,
        maintenance_claimed_until: sql`now() + make_interval(mins => ${MAINTENANCE_MINUTES})`,
      })
      .where("id", "=", args.allocationId)
      .where("status", "=", args.status)
      .where("capacity_released_at", "is", null)
      .where((eb) =>
        eb.or([
          eb("maintenance_claimed_until", "is", null),
          eb("maintenance_claimed_until", "<", sql<Date>`now()`),
        ]),
      )
      .returning("id")
      .executeTakeFirst();
    return claimed ? { allocationId: args.allocationId, token } : undefined;
  });
}

/** Extend a claim this host still holds; false once it lapsed or moved. */
export async function renewAllocationMaintenance(args: {
  db: Kysely<DB>;
  claim: AllocationMaintenanceClaim;
}): Promise<boolean> {
  const renewed = await args.db
    .updateTable("execution_allocations")
    .set({
      maintenance_claimed_until: sql`now() + make_interval(mins => ${MAINTENANCE_MINUTES})`,
    })
    .where("id", "=", args.claim.allocationId)
    .where("maintenance_claim", "=", args.claim.token)
    .returning("id")
    .executeTakeFirst();
  return Boolean(renewed);
}

/** Give a claim back; a claim another host has since taken is left alone. */
export async function releaseAllocationMaintenance(args: {
  db: Kysely<DB>;
  claim: AllocationMaintenanceClaim;
}): Promise<void> {
  await args.db
    .updateTable("execution_allocations")
    .set({ maintenance_claim: null, maintenance_claimed_until: null })
    .where("id", "=", args.claim.allocationId)
    .where("maintenance_claim", "=", args.claim.token)
    .execute();
}

/** This host's maintenance claim lapsed or moved: its work must stop. */
export class AllocationMaintenanceLostError extends Error {
  constructor() {
    super("The workspace's maintenance claim lapsed; another host may use it");
    this.name = "AllocationMaintenanceLostError";
  }
}

/**
 * Run `work` under a claim, renewing it every 30 seconds. `work` calls
 * `held` before each step that touches the workspace: it renews the claim
 * and throws {@link AllocationMaintenanceLostError} once the claim is gone,
 * so a stalled host never saves or destroys a workspace a turn may already
 * use. The claim is given back afterwards unless it was lost.
 */
export async function withAllocationMaintenance<T>(args: {
  db: Kysely<DB>;
  claim: AllocationMaintenanceClaim;
  work: (held: () => Promise<void>) => Promise<T>;
}): Promise<T> {
  let lost = false;
  const held = async () => {
    if (!lost && !(await renewAllocationMaintenance(args))) lost = true;
    if (lost) throw new AllocationMaintenanceLostError();
  };
  const timer = setInterval(() => {
    void renewAllocationMaintenance(args)
      .then((renewed) => {
        if (!renewed) lost = true;
      })
      .catch(() => {});
  }, 30_000);
  timer.unref();
  try {
    return await args.work(held);
  } finally {
    clearInterval(timer);
    if (!lost) await releaseAllocationMaintenance(args).catch(() => {});
  }
}

/**
 * Destroy the workspaces of a node's released Allocations. Successful
 * destruction is the capacity release fence. A local node is cleaned only by
 * the process holding its lease; a remote node by any host while its
 * executor's lease is live (ADR 0192), each Allocation under a claim.
 */
export async function cleanupWorkerAllocations(args: {
  db: Kysely<DB>;
  workerNode: { id: string; token: string } | { id: string; remote: true };
  provider: SandboxProvider;
}): Promise<number> {
  return withSpan(
    {
      tracer: getTracer("@catamorphic/core"),
      name: "worker.cleanup_allocations",
      attributes: { "catamorphic.worker.id": args.workerNode.id },
    },
    async () => {
      const node = args.workerNode;
      const live = await args.db
        .selectFrom("worker_nodes")
        .select("id")
        .where("id", "=", node.id)
        .where("lease_expires_at", ">", sql<Date>`now()`)
        .$if("token" in node, (query) =>
          query.where("lease_token", "=", "token" in node ? node.token : ""),
        )
        .$if(!("token" in node), (query) =>
          query.where("enabled", "=", true).where("remote", "is not", null),
        )
        .executeTakeFirst();
      if (!live) return 0;
      const rows = await args.db
        .selectFrom("execution_allocations")
        .selectAll()
        .where("worker_node_id", "=", args.workerNode.id)
        .where("status", "=", "released")
        .where("capacity_released_at", "is", null)
        .where(({ not, exists, selectFrom }) =>
          not(
            exists(
              selectFrom("agent_sessions as session")
                .innerJoin(
                  "agent_turns as turn",
                  "turn.session_id",
                  "session.id",
                )
                .select("turn.id")
                .whereRef(
                  "session.allocation_id",
                  "=",
                  "execution_allocations.id",
                )
                .where("turn.status", "=", "running")
                .where("turn.lease_expires_at", ">", sql<Date>`now()`),
            ),
          ),
        )
        .where(({ not, exists, selectFrom }) =>
          not(
            exists(
              selectFrom("workflow_runs as run")
                .innerJoin(
                  "execution_jobs as job",
                  "job.workflow_run_id",
                  "run.id",
                )
                .select("job.id")
                .whereRef("run.allocation_id", "=", "execution_allocations.id")
                .where("job.status", "=", "running")
                .where("job.lease_expires_at", ">", sql<Date>`now()`),
            ),
          ),
        )
        .limit(100)
        .execute();
      let cleaned = 0;
      const failures: unknown[] = [];
      for (const row of rows) {
        if (row.sandbox_creation_started && !row.sandbox_provider_id) continue;
        const claim = await claimAllocationMaintenance({
          db: args.db,
          allocationId: row.id,
          status: "released",
        });
        if (!claim) continue;
        try {
          await withAllocationMaintenance({
            db: args.db,
            claim,
            work: async (held) => {
              // Destroying is idempotent: a sandbox already gone counts.
              await held();
              if (row.sandbox_provider_id)
                await args.provider.destroySandbox(row.sandbox_provider_id);
              await args.db
                .updateTable("execution_allocations")
                .set({ capacity_released_at: sql`now()` })
                .where("id", "=", row.id)
                .where("status", "=", "released")
                .where("maintenance_claim", "=", claim.token)
                .execute();
            },
          });
          cleaned++;
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0)
        throw new AggregateError(
          failures,
          `Workspace cleanup failed for ${failures.length} allocation(s): ${String(failures[0])}`,
        );

      return cleaned;
    },
  );
}
