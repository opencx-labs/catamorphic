import type { DB } from "@catamorphic/db";
import {
  describeDisk,
  diskBudgetMb,
  diskFresh,
  type EnvironmentResourcePolicy,
  type MachineDisk,
} from "@catamorphic/sandbox";
import { type Kysely, sql, type Transaction } from "kysely";
import { z } from "zod";

/** A machine's disk report (ADR 0335), as stored with its node. */
export const MachineDiskSchema = z.strictObject({
  path: z.string().max(4096),
  totalBytes: z.number().nonnegative(),
  freeBytes: z.number().nonnegative(),
  floorBytes: z.number().nonnegative(),
  measuredAt: z.string().datetime(),
});

/** A stored report, or undefined for none or one that does not parse. */
export function machineDiskOf(value: unknown): MachineDisk | undefined {
  const parsed = MachineDiskSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

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
  constructor(
    readonly nodeId: string,
    /** The machine is short of disk (ADR 0335): its report, to say so. */
    readonly disk?: MachineDisk,
  ) {
    super(
      disk
        ? `This machine is short of disk (${describeDisk(disk)}), so the workspace waits for room. Archive an unused session or choose another Environment, then retry.`
        : "This server has no workspace capacity available. Archive an unused session or choose another Environment, then retry.",
    );
    this.name = "EnvironmentCapacityError";
  }
}

/** What a machine has reserved: workspaces and their CPU, memory and storage. */
export interface WorkerUsage {
  workspaces: number;
  cpuMillis: number;
  memoryMb: number;
  /** `storageMb` reserved by its Allocations (ADR 0335). */
  storageMb: number;
}

export async function workerUsage(args: {
  db: Kysely<DB> | Transaction<DB>;
  nodeId: string;
}): Promise<WorkerUsage> {
  const usage = await args.db
    .selectFrom("execution_allocations")
    .where("worker_node_id", "=", args.nodeId)
    .where("capacity_released_at", "is", null)
    .select([
      sql<string>`count(*)`.as("workspaces"),
      sql<string>`coalesce(sum(reserved_cpu_millis), 0)`.as("cpu"),
      sql<string>`coalesce(sum(reserved_memory_mb), 0)`.as("memory"),
      sql<string>`coalesce(sum(reserved_storage_mb), 0)`.as("storage"),
    ])
    .executeTakeFirstOrThrow();
  return {
    workspaces: Number(usage.workspaces),
    cpuMillis: Number(usage.cpu),
    memoryMb: Number(usage.memory),
    storageMb: Number(usage.storage),
  };
}

export function capacityFits(args: {
  capacity: WorkerCapacity;
  usage: WorkerUsage;
  resources: EnvironmentResourcePolicy;
  /** The machine's disk report, when it sends one (ADR 0335). */
  disk?: MachineDisk;
}): boolean {
  return (
    args.usage.workspaces + 1 <= args.capacity.workspaces &&
    (args.capacity.cpuMillis === undefined ||
      args.usage.cpuMillis + (args.resources.cpuMillis ?? 0) <=
        args.capacity.cpuMillis) &&
    (args.capacity.memoryMb === undefined ||
      args.usage.memoryMb + (args.resources.memoryMb ?? 0) <=
        args.capacity.memoryMb) &&
    diskFits(args)
  );
}

const MIB = 1024 * 1024;

/**
 * Whether a workspace fits a machine's disk (ADR 0335): with a recent
 * report, free space less its `storageMb` stays at or above the floor,
 * and the machine's reservations stay within its total less its floor.
 * A machine with no recent report is not held to either.
 */
export function diskFits(args: {
  usage: Pick<WorkerUsage, "storageMb">;
  resources: Pick<EnvironmentResourcePolicy, "storageMb">;
  disk?: MachineDisk;
  now?: number;
}): boolean {
  const { disk } = args;
  if (!disk || !diskFresh(disk, args.now)) return true;
  const storageMb = args.resources.storageMb ?? 0;
  return (
    disk.freeBytes - storageMb * MIB >= disk.floorBytes &&
    args.usage.storageMb + storageMb <= diskBudgetMb(disk)
  );
}
