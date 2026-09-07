import { randomUUID } from "node:crypto";
import type { DB } from "@catamorphic/db";
import { getTracer, withSpan } from "@catamorphic/otel";
import type { EnvironmentBinding } from "@catamorphic/sandbox";
import { type Kysely, sql } from "kysely";
import { z } from "zod";
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
    timeoutSeconds: z.number().optional(),
    maxConcurrency: z.number().optional(),
  }),
});

export interface WorkerNodeLease {
  id: string;
  token: string;
}
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
}

/** Host/operator surface. Project access is granted separately by roles. */
export class WorkerNodesService {
  constructor(private readonly db: Kysely<DB>) {}

  async register(args: {
    tenantId: string;
    authorityId: string;
    descriptor: EnvironmentBinding;
    capacity?: WorkerCapacity;
    defaults?: { cpuMillis?: number; memoryMb?: number };
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
                  updated_at: sql`now()`,
                })
                .where("worker_nodes.tenant_id", "=", args.tenantId)
                .where("worker_nodes.authority_id", "=", args.authorityId)
                .where("worker_nodes.enabled", "=", true)
                .where("worker_nodes.lease_expires_at", "<=", sql<Date>`now()`),
            )
            .returning("id")
            .executeTakeFirst();
          if (!node)
            throw new Error(
              "This machine identity is already running or disabled",
            );
          return { id: node.id, token };
        });
      },
    );
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

  async release(args: { lease: WorkerNodeLease }): Promise<void> {
    await this.db
      .updateTable("worker_nodes")
      .set({ lease_expires_at: sql`now()` })
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
