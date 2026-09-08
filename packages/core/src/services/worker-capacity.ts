import type { DB } from "@catamorphic/db";
import type { EnvironmentResourcePolicy } from "@catamorphic/sandbox";
import { type Kysely, sql, type Transaction } from "kysely";
import { z } from "zod";

export const WorkerCapacitySchema = z.strictObject({
  workspaces: z.number().int().positive(),
  cpuMillis: z.number().int().positive().optional(),
  memoryMb: z.number().int().positive().optional(),
});
export type WorkerCapacity = z.infer<typeof WorkerCapacitySchema>;
export const WorkerResourceDefaultsSchema = z.strictObject({
  cpuMillis: z.number().int().positive().optional(),
  memoryMb: z.number().int().positive().optional(),
});

export class EnvironmentCapacityError extends Error {
  constructor(readonly nodeId: string) {
    super(
      "This server has no workspace capacity available. Archive an unused session or choose another Environment, then retry.",
    );
    this.name = "EnvironmentCapacityError";
  }
}

export async function workerUsage(args: {
  db: Kysely<DB> | Transaction<DB>;
  nodeId: string;
}): Promise<{ workspaces: number; cpuMillis: number; memoryMb: number }> {
  const usage = await args.db
    .selectFrom("execution_allocations")
    .where("worker_node_id", "=", args.nodeId)
    .where("capacity_released_at", "is", null)
    .select([
      sql<string>`count(*)`.as("workspaces"),
      sql<string>`coalesce(sum(reserved_cpu_millis), 0)`.as("cpu"),
      sql<string>`coalesce(sum(reserved_memory_mb), 0)`.as("memory"),
    ])
    .executeTakeFirstOrThrow();
  return {
    workspaces: Number(usage.workspaces),
    cpuMillis: Number(usage.cpu),
    memoryMb: Number(usage.memory),
  };
}

export function capacityFits(args: {
  capacity: WorkerCapacity;
  usage: { workspaces: number; cpuMillis: number; memoryMb: number };
  resources: EnvironmentResourcePolicy;
}): boolean {
  return (
    args.usage.workspaces + 1 <= args.capacity.workspaces &&
    (args.capacity.cpuMillis === undefined ||
      args.usage.cpuMillis + (args.resources.cpuMillis ?? 0) <=
        args.capacity.cpuMillis) &&
    (args.capacity.memoryMb === undefined ||
      args.usage.memoryMb + (args.resources.memoryMb ?? 0) <=
        args.capacity.memoryMb)
  );
}
