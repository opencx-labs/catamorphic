import fs from "node:fs";

/**
 * Disk is a resource Work manages on machines (ADR 0336): each machine
 * measures the filesystems Work writes to and reports the one with the
 * least room above its floor.
 */

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

/** The default floor: 10% of a filesystem, at most this. */
export const DEFAULT_DISK_FLOOR_MAX_BYTES = 10 * GIB;

/** The default critical floor: 1% of a filesystem, at most this. */
export const DEFAULT_DISK_CRITICAL_MAX_BYTES = 1 * GIB;

/**
 * A report the server heard longer ago than this is not used for
 * admission; the database judges it, by its own clock.
 */
export const DISK_REPORT_FRESH_MS = 5 * 60_000;

/** An episode ends once free space is back above this times the floor. */
export const DISK_RECOVERY_FACTOR = 1.1;

/** One filesystem a machine writes to, as it measured it. */
export interface MachineDisk {
  /** A path on it, as the machine names it. */
  path: string;
  totalBytes: number;
  freeBytes: number;
  /** What the machine keeps free there: no chat's workspace starts below it. */
  floorBytes: number;
  /**
   * Its critical floor, lower: workflow runs start down to it, so the
   * workflows that free or replace machines still run, and nothing starts
   * below it.
   */
  criticalBytes: number;
  /** ISO time of the measurement. */
  measuredAt: string;
}

/**
 * The floor a machine keeps when the operator sets none (ADR 0336):
 * `workspaces`, the full floor, for a machine many workspaces share (an
 * enrolled worker, a container or microsandbox machine), where one busy
 * workspace must not take the room the others need; `critical`, only the
 * critical floor, for a single server's own machine running its work as
 * local processes on the disk its database and its people's files share,
 * where holding chats back frees nothing.
 */
export type DiskFloorDefault = "workspaces" | "critical";

/**
 * The floor of a filesystem of `totalBytes`: `floorMb` when the operator
 * set one (`WORK_DISK_FLOOR_MB`, 0 keeps none), else by the machine's
 * `defaultFloor`: 10% of it, at most 10 GiB, or its critical floor.
 */
export function diskFloorBytes(args: {
  totalBytes: number;
  floorMb?: number;
  criticalMb?: number;
  defaultFloor?: DiskFloorDefault;
}): number {
  if (args.floorMb !== undefined) return Math.max(0, args.floorMb) * MIB;
  if (args.defaultFloor === "critical")
    return criticalFloorBytes({
      totalBytes: args.totalBytes,
      ...(args.criticalMb !== undefined ? { criticalMb: args.criticalMb } : {}),
    });
  return Math.min(
    Math.floor(args.totalBytes * 0.1),
    DEFAULT_DISK_FLOOR_MAX_BYTES,
  );
}

/** `criticalMb` when set (0 keeps none), else 1% of the filesystem, at most 1 GiB. */
function criticalFloorBytes(args: {
  totalBytes: number;
  criticalMb?: number;
}): number {
  return args.criticalMb !== undefined
    ? Math.max(0, args.criticalMb) * MIB
    : Math.min(
        Math.floor(args.totalBytes * 0.01),
        DEFAULT_DISK_CRITICAL_MAX_BYTES,
      );
}

/**
 * The critical floor of a filesystem: `criticalMb` when the operator set
 * one (`WORK_DISK_CRITICAL_MB`, 0 keeps none), else 1% of it, at most
 * 1 GiB, and never above its floor.
 */
export function diskCriticalBytes(args: {
  totalBytes: number;
  criticalMb?: number;
  floorBytes: number;
}): number {
  return Math.min(criticalFloorBytes(args), args.floorBytes);
}

/**
 * Measure each path's filesystem once (paths on one device are one
 * filesystem) and answer the one with the least room above its floor.
 * Paths that do not exist or cannot be measured are skipped; undefined
 * when none could be.
 */
export function measureDisk(args: {
  paths: readonly string[];
  floorMb?: number;
  criticalMb?: number;
  /** The floor this machine keeps when no `floorMb` is set. */
  defaultFloor?: DiskFloorDefault;
  now?: Date;
  /** For tests: statfs and stat as Node's. */
  statfs?: (path: string) => { bsize: number; blocks: number; bavail: number };
  device?: (path: string) => number;
}): MachineDisk | undefined {
  const statfs = args.statfs ?? ((path: string) => fs.statfsSync(path));
  const device = args.device ?? ((path: string) => fs.statSync(path).dev);
  const measuredAt = (args.now ?? new Date()).toISOString();
  const seen = new Set<number>();
  let tightest: MachineDisk | undefined;
  for (const path of args.paths) {
    let measured: MachineDisk;
    try {
      const dev = device(path);
      if (seen.has(dev)) continue;
      seen.add(dev);
      const stats = statfs(path);
      const totalBytes = stats.blocks * stats.bsize;
      const floorBytes = diskFloorBytes({
        totalBytes,
        ...(args.floorMb !== undefined ? { floorMb: args.floorMb } : {}),
        ...(args.criticalMb !== undefined
          ? { criticalMb: args.criticalMb }
          : {}),
        ...(args.defaultFloor ? { defaultFloor: args.defaultFloor } : {}),
      });
      measured = {
        path,
        totalBytes,
        // What an unprivileged writer may still use.
        freeBytes: stats.bavail * stats.bsize,
        floorBytes,
        criticalBytes: diskCriticalBytes({
          totalBytes,
          floorBytes,
          ...(args.criticalMb !== undefined
            ? { criticalMb: args.criticalMb }
            : {}),
        }),
        measuredAt,
      };
    } catch {
      continue;
    }
    if (!tightest || headroom(measured) < headroom(tightest))
      tightest = measured;
  }
  return tightest;
}

/** Bytes above the floor; negative under it. */
export function headroom(disk: MachineDisk): number {
  return disk.freeBytes - disk.floorBytes;
}

/** Whether the machine has less free space than it keeps. */
export function diskLow(disk: MachineDisk): boolean {
  return disk.floorBytes > 0 && disk.freeBytes < disk.floorBytes;
}

/** Whether an episode under the floor is over (ADR 0336). */
export function diskRecovered(disk: MachineDisk): boolean {
  return disk.freeBytes >= disk.floorBytes * DISK_RECOVERY_FACTOR;
}

/** The storage a machine can reserve (MiB): its total less its floor. */
export function diskBudgetMb(disk: MachineDisk): number {
  return Math.max(0, Math.floor((disk.totalBytes - disk.floorBytes) / MIB));
}

/** What a full disk prints: errno names and messages of Linux and Docker. */
const OUT_OF_DISK =
  /\bENOSPC\b|no space left on device|not enough space on the disk|disk quota exceeded|\bEDQUOT\b/i;

/** Whether output says a write found no room. Forgeable; never acts. */
export function saysOutOfDisk(text: string | null | undefined): boolean {
  return Boolean(text && OUT_OF_DISK.test(text));
}

/** Bytes as people read them: `12.3 GB`. */
export function formatBytes(bytes: number): string {
  const units = ["bytes", "KB", "MB", "GB", "TB"];
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

/** The machine's numbers, in words. */
export function describeDisk(disk: MachineDisk): string {
  return `${formatBytes(disk.freeBytes)} free of ${formatBytes(disk.totalBytes)}${
    disk.floorBytes > 0
      ? `, where Work keeps ${formatBytes(disk.floorBytes)} free`
      : ""
  }`;
}

/**
 * Why a failure happened when the disk is to blame (ADR 0336), or
 * undefined: the machine reported free space under its floor (Work's own
 * measurement), or the output says a write found no room (a hint: code
 * the chat runs can print it).
 */
export function outOfDiskReason(args: {
  disk?: MachineDisk | null;
  texts: ReadonlyArray<string | null | undefined>;
}): string | undefined {
  const { disk } = args;
  if (disk && diskLow(disk))
    return `The machine ran out of disk: ${describeDisk(disk)}.`;
  if (!args.texts.some(saysOutOfDisk)) return undefined;
  return disk
    ? `The workspace ran out of disk space (no space left on device); the machine reports ${describeDisk(disk)}.`
    : "The workspace ran out of disk space (no space left on device).";
}
