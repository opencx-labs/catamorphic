import { randomUUID } from "node:crypto";
import type { DB } from "@catamorphic/db";
import { getTracer, withSpan } from "@catamorphic/otel";
import type { EnvironmentBinding, SandboxProvider } from "@catamorphic/sandbox";
import { type Kysely, sql } from "kysely";
import { z } from "zod";
import { nodeExecutor, RemoteOperationQueue } from "./remote-operations.js";
import { toJson } from "./run-coordinator.js";
import {
  capacityFits,
  type WorkerCapacity,
  WorkerCapacitySchema,
  WorkerResourceDefaultsSchema,
  workerUsage,
} from "./worker-capacity.js";

const tracer = getTracer("@catamorphic/core");
const descriptorSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
  trust: z.enum(["local", "managed"]),
  isolation: z.enum(["none", "process", "sandbox"]),
  workloads: z.array(z.enum(["agent", "workflow"])),
  agentTopologies: z.array(
    z.enum(["controller", "native", "contained", "external"]),
  ),
  capabilities: z.array(z.string()),
  resourceLimits: z
    .array(z.enum(["cpuMillis", "memoryMb", "storageMb", "gpu"]))
    .optional(),
  resources: z.object({
    cpuMillis: z.number().optional(),
    memoryMb: z.number().optional(),
    storageMb: z.number().optional(),
    gpu: z.boolean().optional(),
    commandTimeoutSeconds: z.number().optional(),
    maxConcurrency: z.number().optional(),
  }),
  labels: z.record(z.string(), z.string()).optional(),
});

export interface WorkerNodeLease {
  id: string;
  token: string;
}

/**
 * What a remote executor offers beside its descriptor (ADR 0192): any host
 * builds the node's forwarding sandbox provider from it.
 */
export const RemoteNodeOfferSchema = z.object({
  workspaceRoot: z.string().startsWith("/"),
  processes: z.boolean(),
});
export type RemoteNodeOffer = z.infer<typeof RemoteNodeOfferSchema>;

export interface WorkerNode {
  id: string;
  descriptor: EnvironmentBinding;
  enabled: boolean;
  available: boolean;
  lastSeenAt: string;
  capacity?: WorkerCapacity;
  defaults: { cpuMillis?: number; memoryMb?: number };
  usage: { workspaces: number; cpuMillis: number; memoryMb: number };
  acceptingWork: boolean;
  /**
   * Set for a node whose lease belongs to a remote executor (ADR 0192): any
   * host of its authority runs its work through the operation queue.
   */
  remote?: RemoteNodeOffer;
}

/** Every node lease lasts this long unless renewed (the SQL's 45 seconds). */
export const WORKER_NODE_LEASE_MS = 45_000;

/** Another process holds this node's lease, or the node is disabled. */
export class WorkerNodeLeaseHeldError extends Error {
  constructor() {
    super("This machine identity is already running or disabled");
    this.name = "WorkerNodeLeaseHeldError";
  }
}

/**
 * A newer process of this remote executor holds the node (ADR 0192): an
 * older epoch never takes the lease back while the newer one is live.
 */
export class RemoteEpochSupersededError extends Error {
  constructor() {
    super("A newer process of this machine connected; this one must stop");
    this.name = "RemoteEpochSupersededError";
  }
}

/**
 * An epoch is a UUIDv7 its process chose at start, so later processes sort
 * after earlier ones.
 */
export const REMOTE_EPOCH_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Host/operator surface. Project access is granted separately by roles. */
export class WorkerNodesService {
  constructor(private readonly db: Kysely<DB>) {}

  async register(args: {
    tenantId: string;
    authorityId: string;
    descriptor: EnvironmentBinding;
    capacity?: WorkerCapacity;
    defaults?: { cpuMillis?: number; memoryMb?: number };
    /**
     * The node's identity lasts this one process (ADR 0190): it never
     * registers again, so once its lease is gone any host may recover its
     * work with {@link NodeRecoveryService}.
     */
    disposable?: boolean;
    /**
     * Take the lease of a disabled node too. A single server holds its own
     * lease while disabled, so its operator can enable it again; a disabled
     * node renews nothing and takes no work.
     */
    evenIfDisabled?: boolean;
  }): Promise<WorkerNodeLease> {
    const descriptor = descriptorSchema.parse(args.descriptor);
    const capacity = args.capacity
      ? WorkerCapacitySchema.parse(args.capacity)
      : undefined;
    const defaults = WorkerResourceDefaultsSchema.parse(args.defaults ?? {});
    for (const key of ["cpuMillis", "memoryMb"] as const) {
      if (capacity?.[key] !== undefined) {
        if (
          defaults[key] === undefined ||
          !descriptor.resourceLimits?.includes(key)
        ) {
          throw new Error(
            `A '${key}' machine budget requires an enforceable workspace default`,
          );
        }
        if (defaults[key] > capacity[key])
          throw new Error(`Default '${key}' exceeds the machine budget`);
      }
    }
    const token = randomUUID();
    return withSpan(
      {
        tracer,
        name: "worker.register",
        attributes: {
          "catamorphic.worker.id": descriptor.id,
          "catamorphic.tenant.id": args.tenantId,
        },
      },
      async () => {
        return this.db.transaction().execute(async (trx) => {
          await trx
            .insertInto("tenants")
            .values({ id: args.tenantId, name: args.tenantId })
            .onConflict((oc) => oc.column("id").doNothing())
            .execute();
          const node = await trx
            .insertInto("worker_nodes")
            .values({
              id: descriptor.id,
              tenant_id: args.tenantId,
              authority_id: args.authorityId,
              descriptor: toJson(descriptor),
              capacity: capacity ? toJson(capacity) : null,
              default_resources: toJson(defaults),
              lease_token: token,
              lease_expires_at: sql`now() + interval '45 seconds'`,
              disposable: args.disposable ?? false,
              remote: null,
            })
            .onConflict((oc) =>
              oc
                .column("id")
                .doUpdateSet({
                  descriptor: toJson(descriptor),
                  capacity: capacity ? toJson(capacity) : null,
                  default_resources: toJson(defaults),
                  lease_token: token,
                  lease_expires_at: sql`now() + interval '45 seconds'`,
                  disposable: args.disposable ?? false,
                  remote: null,
                  updated_at: sql`now()`,
                })
                .where("worker_nodes.tenant_id", "=", args.tenantId)
                .where("worker_nodes.authority_id", "=", args.authorityId)
                .where(
                  "worker_nodes.enabled",
                  "in",
                  args.evenIfDisabled ? [true, false] : [true],
                )
                .where("worker_nodes.lease_expires_at", "<=", sql<Date>`now()`),
            )
            .returning("id")
            .executeTakeFirst();
          if (!node) throw new WorkerNodeLeaseHeldError();
          return { id: node.id, token };
        });
      },
    );
  }

  /**
   * A remote executor connects with the epoch it chose at process start
   * (ADR 0192); the caller has already proven its credential. The same epoch
   * again only refreshes its offer and lease. A later epoch takes the lease
   * over at once and, in the same transaction, fails every operation the old
   * epoch was sent as uncertain: they are never delivered again. An earlier
   * epoch is refused while the current one's lease is live, so a stale
   * process cannot take the machine back from its successor; after a lapse
   * any epoch may. Refused while the operator has the node disabled.
   */
  async connectRemote(args: {
    tenantId: string;
    authorityId: string;
    descriptor: EnvironmentBinding;
    capacity?: WorkerCapacity;
    defaults?: { cpuMillis?: number; memoryMb?: number };
    epoch: string;
    offer: RemoteNodeOffer;
  }): Promise<{ lease: WorkerNodeLease; superseded: string | null }> {
    const descriptor = descriptorSchema.parse(args.descriptor);
    const capacity = args.capacity
      ? WorkerCapacitySchema.parse(args.capacity)
      : undefined;
    const defaults = WorkerResourceDefaultsSchema.parse(args.defaults ?? {});
    const offer = RemoteNodeOfferSchema.parse(args.offer);
    if (!REMOTE_EPOCH_PATTERN.test(args.epoch))
      throw new Error("An executor epoch must be a lowercase UUIDv7");
    return withSpan(
      {
        tracer,
        name: "worker.connect",
        attributes: {
          "catamorphic.worker.id": descriptor.id,
          "catamorphic.tenant.id": args.tenantId,
        },
      },
      async (span) =>
        this.db.transaction().execute(async (trx) => {
          await trx
            .insertInto("tenants")
            .values({ id: args.tenantId, name: args.tenantId })
            .onConflict((oc) => oc.column("id").doNothing())
            .execute();
          const current = await trx
            .selectFrom("worker_nodes")
            .select(["lease_token", "enabled", "tenant_id", "authority_id"])
            .select(sql<boolean>`lease_expires_at > now()`.as("live"))
            .where("id", "=", descriptor.id)
            .forUpdate()
            .executeTakeFirst();
          if (
            current &&
            (!current.enabled ||
              current.tenant_id !== args.tenantId ||
              current.authority_id !== args.authorityId)
          )
            throw new WorkerNodeLeaseHeldError();
          if (
            current?.live &&
            current.lease_token !== args.epoch &&
            args.epoch < current.lease_token
          )
            throw new RemoteEpochSupersededError();
          const values = {
            descriptor: toJson(descriptor),
            capacity: capacity ? toJson(capacity) : null,
            default_resources: toJson(defaults),
            lease_token: args.epoch,
            lease_expires_at: sql<Date>`now() + interval '45 seconds'`,
            disposable: false,
            remote: toJson(offer),
          };
          await trx
            .insertInto("worker_nodes")
            .values({
              id: descriptor.id,
              tenant_id: args.tenantId,
              authority_id: args.authorityId,
              ...values,
            })
            .onConflict((oc) =>
              oc
                .column("id")
                .doUpdateSet({ ...values, updated_at: sql`now()` }),
            )
            .execute();
          const superseded =
            current && current.lease_token !== args.epoch
              ? current.lease_token
              : null;
          if (superseded) {
            const failed = await RemoteOperationQueue.failLease({
              transaction: trx,
              executor: nodeExecutor(descriptor.id),
              leaseToken: superseded,
            });
            span.setAttribute("catamorphic.worker.operations_failed", failed);
          }
          span.setAttribute(
            "catamorphic.worker.superseded",
            Boolean(superseded),
          );
          return {
            lease: { id: descriptor.id, token: args.epoch },
            superseded,
          };
        }),
    );
  }

  /**
   * A remote executor's own call extends its lease while its epoch is
   * current (ADR 0192), even after a lapse: nobody else can take it over.
   * False once a newer epoch took over, or the operator disabled the node.
   */
  async renewRemote(args: { lease: WorkerNodeLease }): Promise<boolean> {
    const row = await this.db
      .updateTable("worker_nodes")
      .set({
        lease_expires_at: sql`now() + interval '45 seconds'`,
        updated_at: sql`now()`,
      })
      .where("id", "=", args.lease.id)
      .where("lease_token", "=", args.lease.token)
      .where("enabled", "=", true)
      .where("remote", "is not", null)
      .returning("id")
      .executeTakeFirst();
    return Boolean(row);
  }

  /** The node's lease token while its lease is live and it is enabled. */
  async liveToken(args: { nodeId: string }): Promise<string | undefined> {
    const row = await this.db
      .selectFrom("worker_nodes")
      .select("lease_token")
      .where("id", "=", args.nodeId)
      .where("enabled", "=", true)
      .where("lease_expires_at", ">", sql<Date>`now()`)
      .executeTakeFirst();
    return row?.lease_token;
  }

  /**
   * The sandbox provider of a remote node, built from its row on any host
   * (ADR 0192). Each operation is addressed to the executor's current epoch
   * and fails at once while its lease is not live.
   */
  remoteProvider(args: {
    nodeId: string;
    offer: RemoteNodeOffer;
    /** Names the executor in errors, such as "The worker". */
    label: string;
  }): SandboxProvider {
    return new RemoteOperationQueue(this.db).provider({
      executor: nodeExecutor(args.nodeId),
      leaseToken: () => this.liveToken({ nodeId: args.nodeId }),
      leaseHeld: async (token) =>
        (await this.liveToken({ nodeId: args.nodeId })) === token,
      label: args.label,
      workspaceRoot: args.offer.workspaceRoot,
      processes: args.offer.processes,
      attributes: { "catamorphic.worker.id": args.nodeId },
    });
  }

  async renew(args: { lease: WorkerNodeLease }): Promise<boolean> {
    const row = await this.db
      .updateTable("worker_nodes")
      .set({
        lease_expires_at: sql`now() + interval '45 seconds'`,
        updated_at: sql`now()`,
      })
      .where("id", "=", args.lease.id)
      .where("lease_token", "=", args.lease.token)
      .where("enabled", "=", true)
      .where("lease_expires_at", ">", sql<Date>`now()`)
      .returning("id")
      .executeTakeFirst();
    return Boolean(row);
  }

  /**
   * Give the lease back. A disposable node also stops taking work for good,
   * so its work is recovered at once rather than after the grace period.
   */
  async release(args: { lease: WorkerNodeLease }): Promise<void> {
    await this.db
      .updateTable("worker_nodes")
      .set({
        lease_expires_at: sql`now()`,
        enabled: sql<boolean>`enabled AND NOT disposable`,
      })
      .where("id", "=", args.lease.id)
      .where("lease_token", "=", args.lease.token)
      .execute();
  }

  async list(args: {
    tenantId: string;
    authorityId: string;
  }): Promise<WorkerNode[]> {
    const rows = await this.db
      .selectFrom("worker_nodes")
      .selectAll()
      .select(
        sql<boolean>`enabled AND lease_expires_at > now()`.as("available"),
      )
      .where("tenant_id", "=", args.tenantId)
      .where("authority_id", "=", args.authorityId)
      .orderBy("id")
      .execute();
    return Promise.all(
      rows.map(async (row) => {
        const capacity = row.capacity
          ? WorkerCapacitySchema.parse(row.capacity)
          : undefined;
        const defaults = WorkerResourceDefaultsSchema.parse(
          row.default_resources,
        );
        const usage = await workerUsage({ db: this.db, nodeId: row.id });
        return {
          id: row.id,
          descriptor: descriptorSchema.parse(row.descriptor),
          enabled: row.enabled,
          available: row.available,
          lastSeenAt: row.updated_at.toISOString(),
          capacity,
          defaults,
          usage,
          acceptingWork:
            row.available &&
            (!capacity ||
              capacityFits({ capacity, usage, resources: defaults })),
          ...(row.remote
            ? { remote: RemoteNodeOfferSchema.parse(row.remote) }
            : {}),
        };
      }),
    );
  }

  async workspaces(args: {
    tenantId: string;
    authorityId: string;
    nodeId: string;
  }) {
    return this.db
      .selectFrom("execution_allocations as allocation")
      .innerJoin("worker_nodes as node", "node.id", "allocation.worker_node_id")
      .where("node.id", "=", args.nodeId)
      .where("node.tenant_id", "=", args.tenantId)
      .where("node.authority_id", "=", args.authorityId)
      .where("allocation.capacity_released_at", "is", null)
      .select([
        "allocation.id",
        "allocation.project_id as projectId",
        "allocation.root_workload_id as workloadId",
        "allocation.workload_kind as workloadKind",
        "allocation.status",
        "allocation.sandbox_provider_id as sandboxId",
        "allocation.sandbox_creation_started as creationStarted",
        "allocation.reserved_cpu_millis as cpuMillis",
        "allocation.reserved_memory_mb as memoryMb",
      ])
      .execute();
  }

  /** Operator attestation after inspecting the physical backend, never automatic expiry. */
  async confirmWorkspaceDestroyed(args: {
    tenantId: string;
    authorityId: string;
    nodeId: string;
    allocationId: string;
  }) {
    const row = await this.db
      .updateTable("execution_allocations")
      .set({ capacity_released_at: sql`now()` })
      .where("id", "=", args.allocationId)
      .where("tenant_id", "=", args.tenantId)
      .where("worker_node_id", "=", args.nodeId)
      .where("status", "=", "released")
      .where("capacity_released_at", "is", null)
      .where(({ exists, selectFrom }) =>
        exists(
          selectFrom("worker_nodes")
            .select("id")
            .where("id", "=", args.nodeId)
            .where("authority_id", "=", args.authorityId)
            .where("tenant_id", "=", args.tenantId),
        ),
      )
      .returning("id")
      .executeTakeFirst();
    return Boolean(row);
  }

  async setEnabled(args: {
    tenantId: string;
    authorityId: string;
    nodeId: string;
    enabled: boolean;
  }): Promise<boolean> {
    const changed = await this.db
      .updateTable("worker_nodes")
      .set({ enabled: args.enabled })
      .where("id", "=", args.nodeId)
      .where("tenant_id", "=", args.tenantId)
      .where("authority_id", "=", args.authorityId)
      .returning("id")
      .executeTakeFirst();
    return Boolean(changed);
  }
}
