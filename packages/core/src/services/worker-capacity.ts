import type { DB } from "@catamorphic/db";
import {
  DISK_REPORT_FRESH_MS,
  diskBudgetMb,
  type EnvironmentResourcePolicy,
  formatBytes,
  type MachineDisk,
  type WorkloadKind,
} from "@catamorphic/sandbox";
import { type Kysely, sql, type Transaction } from "kysely";
import { z } from "zod";

/** A machine's disk report (ADR 0335), as stored with its node. */
export const MachineDiskSchema = z.strictObject({
  path: z.string().max(4096),
  totalBytes: z.number().nonnegative(),
  freeBytes: z.number().nonnegative(),
  floorBytes: z.number().nonnegative(),
  criticalBytes: z.number().nonnegative(),
  measuredAt: z.string().datetime({ offset: true }),
});

/** A stored report, or undefined for none or one that does not parse. */
export function machineDiskOf(value: unknown): MachineDisk | undefined {
  const parsed = MachineDiskSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Whether a node's report is recent enough to admit by (ADR 0335), judged
 * by the database's clock against the time it stamped on arrival, so no
 * replica's clock decides.
 */
export const diskFreshSql = sql<boolean>`coalesce((worker_nodes.disk->>'measuredAt')::timestamptz > now() - make_interval(secs => ${DISK_REPORT_FRESH_MS / 1000}), false)`;

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

/**
 * Why a machine's disk refused work (ADR 0335): its report, what the work
 * reserves of it, and the floor that held it (the critical floor for a
 * workflow run).
 */
export interface DiskShortfall {
  disk: MachineDisk;
  storageMb?: number;
  floorBytes: number;
}

export class EnvironmentCapacityError extends Error {
  /** The machine's disk report when its disk refused the work. */
  readonly disk?: MachineDisk;

  constructor(
    readonly nodeId: string,
    /** The machine is short of disk for the work (ADR 0335), to say so. */
    readonly short?: DiskShortfall,
  ) {
    super(
      short
        ? shortOfDiskMessage(short)
        : "This server has no workspace capacity available. Archive an unused session or choose another Environment, then retry.",
    );
    this.name = "EnvironmentCapacityError";
    if (short) this.disk = short.disk;
  }
}

/**
 * A disk refusal in plain words: what the machine has and keeps, and that
 * only free space on it helps. Archiving a chat or choosing another
 * Environment frees no disk, and no other machine had room when this was
 * said, so neither is suggested.
 */
function shortOfDiskMessage(short: DiskShortfall): string {
  const { disk } = short;
  const has = `This machine has ${formatBytes(disk.freeBytes)} free of ${formatBytes(disk.totalBytes)}${
    short.floorBytes > 0
      ? `, and Work keeps ${formatBytes(short.floorBytes)} free on it`
      : ""
  }`;
  const why = short.storageMb
    ? `so it has no room for the ${formatBytes(short.storageMb * MIB)} this work reserves`
    : "so this work cannot start on it";
  return `${has}, ${why}. Free space on it, then try again.`;
}

/**
 * The floor that holds work of `workload` on a machine (ADR 0335): the
 * critical floor for a workflow run, else the full floor. A cache fill
 * names no workload: it meets the full floor.
 */
export function floorFor(args: {
  disk: MachineDisk;
  workload?: WorkloadKind;
}): number {
  return args.workload === "workflow"
    ? args.disk.criticalBytes
    : args.disk.floorBytes;
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
  /** An Allocation not to count: one about to be given back. */
  excluding?: string;
}): Promise<WorkerUsage> {
  const usage = await args.db
    .selectFrom("execution_allocations")
    .where("worker_node_id", "=", args.nodeId)
    .where("capacity_released_at", "is", null)
    .$if(args.excluding !== undefined, (query) =>
      query.where("id", "!=", args.excluding ?? ""),
    )
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
 * Whether work fits a machine's disk (ADR 0335): free space less its
 * `storageMb` stays at or above the floor (a workflow run's, the lower
 * critical floor), and the machine's reservations stay within its total
 * less its floor. `disk` is the machine's recent report (see
 * {@link diskFreshSql}); a machine with none is not held to either.
 */
export function diskFits(args: {
  usage: Pick<WorkerUsage, "storageMb">;
  resources: Pick<EnvironmentResourcePolicy, "storageMb">;
  disk?: MachineDisk;
  /** The work's kind: a workflow run is held to the critical floor. */
  workload?: WorkloadKind;
}): boolean {
  const { disk } = args;
  if (!disk) return true;
  const storageMb = args.resources.storageMb ?? 0;
  const floor = floorFor({
    disk,
    ...(args.workload ? { workload: args.workload } : {}),
  });
  return (
    disk.freeBytes - storageMb * MIB >= floor &&
    args.usage.storageMb + storageMb <= diskBudgetMb(disk)
  );
}
