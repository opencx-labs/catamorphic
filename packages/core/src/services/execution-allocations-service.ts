import type { DB } from "@catamorphic/db";
import type {
  EnvironmentBinding,
  EnvironmentRequirements,
  WorkloadKind,
} from "@catamorphic/sandbox";
import type { Kysely, Selectable, Transaction } from "kysely";
import { z } from "zod";
import type { Identity } from "../identity.js";
import type { ResolvedConnectionBinding } from "./connection-types.js";
import { requireTenantProject } from "./projects-service.js";
import { toJson } from "./run-coordinator.js";

const AllocationPolicySchema = z.object({
  binding: z.object({
    id: z.string(),
    label: z.string(),
    description: z.string().optional(),
    trust: z.enum(["local", "managed"]),
    isolation: z.enum(["none", "process", "sandbox"]),
    workloads: z.array(z.enum(["agent", "workflow"])),
    agentTopologies: z.array(
      z.enum(["controller", "contained", "native", "external"]),
    ),
    capabilities: z.array(z.string()),
    resources: z.record(z.string(), z.union([z.number(), z.boolean()])),
  }),
  requirements: z.object({
    workload: z.enum(["agent", "workflow"]),
    topology: z
      .enum(["controller", "contained", "native", "external"])
      .optional(),
    trust: z.enum(["local", "managed"]).optional(),
    isolation: z.enum(["none", "process", "sandbox"]).optional(),
    capabilities: z.array(z.string()).optional(),
    resources: z
      .record(z.string(), z.union([z.number(), z.boolean()]))
      .optional(),
  }),
  connections: z
    .array(
      z.object({
        bindingId: z.string().uuid(),
        connectionId: z.string().uuid(),
        alias: z.string(),
        providerKind: z.string(),
        principalKind: z.enum(["member", "project_service", "tenant_service"]),
        capabilities: z.array(z.string()),
      }),
    )
    .optional(),
});

export interface EnvironmentAllocationPolicy {
  binding: EnvironmentBinding;
  requirements: EnvironmentRequirements;
  connections?: readonly ResolvedConnectionBinding[];
}

export interface ExecutionAllocation {
  id: string;
  projectId: string;
  environmentName: string;
  bindingId: string;
  workloadKind: WorkloadKind;
  rootWorkloadId: string;
  workerNodeId: string | null;
  policy: EnvironmentAllocationPolicy;
  status: "active" | "released";
  createdAt: string;
  releasedAt: string | null;
}

export class ExecutionAllocationConflictError extends Error {
  constructor(readonly rootWorkloadId: string) {
    super(`Workload '${rootWorkloadId}' already has an active Allocation`);
    this.name = "ExecutionAllocationConflictError";
  }
}

export class ExecutionAllocationsService {
  constructor(private readonly db: Kysely<DB>) {}

  async create(args: {
    identity: Identity;
    projectId: string;
    environmentName: string;
    workloadKind: WorkloadKind;
    rootWorkloadId: string;
    workerNodeId?: string;
    policy: EnvironmentAllocationPolicy;
    transaction?: Transaction<DB>;
  }): Promise<ExecutionAllocation> {
    const executor = args.transaction ?? this.db;
    await requireTenantProject(
      executor,
      args.identity.tenantId,
      args.projectId,
    );
    try {
      const row = await executor
        .insertInto("execution_allocations")
        .values({
          tenant_id: args.identity.tenantId,
          project_id: args.projectId,
          environment_name: args.environmentName,
          binding_id: args.policy.binding.id,
          workload_kind: args.workloadKind,
          root_workload_id: args.rootWorkloadId,
          worker_node_id: args.workerNodeId ?? null,
          policy_snapshot: toJson(args.policy),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return mapAllocation(row);
    } catch (cause) {
      if (
        cause instanceof Error &&
        cause.message.includes("uq_execution_allocations_active_workload")
      ) {
        throw new ExecutionAllocationConflictError(args.rootWorkloadId);
      }
      throw cause;
    }
  }

  async get(args: {
    identity: Identity;
    allocationId: string;
  }): Promise<ExecutionAllocation | undefined> {
    const row = await this.db
      .selectFrom("execution_allocations")
      .where("tenant_id", "=", args.identity.tenantId)
      .where("id", "=", args.allocationId)
      .selectAll()
      .executeTakeFirst();
    return row ? mapAllocation(row) : undefined;
  }

  async release(args: {
    identity: Identity;
    allocationId: string;
    transaction?: Transaction<DB>;
  }): Promise<ExecutionAllocation | undefined> {
    const row = await (args.transaction ?? this.db)
      .updateTable("execution_allocations")
      .set({ status: "released", released_at: new Date() })
      .where("tenant_id", "=", args.identity.tenantId)
      .where("id", "=", args.allocationId)
      .where("status", "=", "active")
      .returningAll()
      .executeTakeFirst();
    return row ? mapAllocation(row) : undefined;
  }
}

function mapAllocation(
  row: Selectable<DB["execution_allocations"]>,
): ExecutionAllocation {
  const policy = AllocationPolicySchema.parse(row.policy_snapshot);
  return {
    id: row.id,
    projectId: row.project_id,
    environmentName: row.environment_name,
    bindingId: row.binding_id,
    workloadKind: row.workload_kind as WorkloadKind,
    rootWorkloadId: row.root_workload_id,
    workerNodeId: row.worker_node_id,
    policy,
    status: row.status as "active" | "released",
    createdAt: row.created_at.toISOString(),
    releasedAt: row.released_at?.toISOString() ?? null,
  };
}
