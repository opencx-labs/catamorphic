import type { DB } from "@catamorphic/db";
import { getTracer, withSpan } from "@catamorphic/otel";
import type {
  CreateSandboxOpts,
  SandboxProvider,
  SandboxResources,
} from "@catamorphic/sandbox";
import { type Kysely, sql } from "kysely";
import type { ExecutionAllocation } from "./execution-allocations-service.js";

/** One sandbox per Allocation. Never reuse another workload's filesystem or budget. */
export function allocationSandboxProvider(args: {
  db: Kysely<DB>;
  allocation: ExecutionAllocation;
  provider: SandboxProvider;
  workerLeaseToken?: string;
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
    if (allocation.workerNodeId && args.workerLeaseToken) {
      const live = await db
        .selectFrom("worker_nodes")
        .select("id")
        .where("id", "=", allocation.workerNodeId)
        .where("lease_token", "=", args.workerLeaseToken)
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
    const handle = await provider.createSandbox({
      ...opts,
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
  return {
    workspaceRoot: provider.workspaceRoot,
    resourceLimits: provider.resourceLimits,
    isolation: provider.isolation,
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
          ...(limits?.timeoutSeconds
            ? {
                timeout: Math.min(
                  opts?.timeout ?? limits.timeoutSeconds,
                  limits.timeoutSeconds,
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

/** Run on the physical owner. Successful destruction is the capacity release fence. */
export async function cleanupWorkerAllocations(args: {
  db: Kysely<DB>;
  workerNode: { id: string; token: string };
  provider: SandboxProvider;
}): Promise<number> {
  return withSpan(
    {
      tracer: getTracer("@catamorphic/core"),
      name: "worker.cleanup_allocations",
      attributes: { "catamorphic.worker.id": args.workerNode.id },
    },
    async () => {
      const live = await args.db
        .selectFrom("worker_nodes")
        .select("id")
        .where("id", "=", args.workerNode.id)
        .where("lease_token", "=", args.workerNode.token)
        .where("lease_expires_at", ">", sql<Date>`now()`)
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
        try {
          if (row.sandbox_provider_id)
            await args.provider.destroySandbox(row.sandbox_provider_id);
          await args.db
            .updateTable("execution_allocations")
            .set({ capacity_released_at: sql`now()` })
            .where("id", "=", row.id)
            .where("status", "=", "released")
            .execute();
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
