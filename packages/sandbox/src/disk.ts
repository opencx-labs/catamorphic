import fs from "node:fs";

/**
 * Disk is a resource Work manages on machines (ADR 0335): each machine
 * measures the filesystems Work writes to and reports the one with the
 * least room above its floor.
 */

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

/** The default floor: 10% of a filesystem, at most this. */
export const DEFAULT_DISK_FLOOR_MAX_BYTES = 10 * GIB;

/** A report older than this is not used for admission. */
export const DISK_REPORT_FRESH_MS = 5 * 60_000;

/** An episode ends once free space is back above this times the floor. */
export const DISK_RECOVERY_FACTOR = 1.1;

/** One filesystem a machine writes to, as it measured it. */
export interface MachineDisk {
  /** A path on it, as the machine names it. */
  path: string;
  totalBytes: number;
  freeBytes: number;
  /** What the machine keeps free there: admission never goes below it. */
  floorBytes: number;
  /** ISO time of the measurement. */
  measuredAt: string;
}

/**
 * The floor of a filesystem of `totalBytes`: `floorMb` when the operator
 * set one (`WORK_DISK_FLOOR_MB`, 0 keeps none), else 10% of it, at most
 * 10 GiB.
 */
export function diskFloorBytes(args: {
  totalBytes: number;
  floorMb?: number;
}): number {
  if (args.floorMb !== undefined) return Math.max(0, args.floorMb) * MIB;
  return Math.min(
    Math.floor(args.totalBytes * 0.1),
    DEFAULT_DISK_FLOOR_MAX_BYTES,
  );
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
      measured = {
        path,
        totalBytes,
        // What an unprivileged writer may still use.
        freeBytes: stats.bavail * stats.bsize,
        floorBytes: diskFloorBytes({
          totalBytes,
          ...(args.floorMb !== undefined ? { floorMb: args.floorMb } : {}),
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

/** Whether an episode under the floor is over (ADR 0335). */
export function diskRecovered(disk: MachineDisk): boolean {
  return disk.freeBytes >= disk.floorBytes * DISK_RECOVERY_FACTOR;
}

/** The storage a machine can reserve (MiB): its total less its floor. */
export function diskBudgetMb(disk: MachineDisk): number {
  return Math.max(0, Math.floor((disk.totalBytes - disk.floorBytes) / MIB));
}

/** Whether a report is recent enough to admit by (ADR 0335). */
export function diskFresh(disk: MachineDisk, now = Date.now()): boolean {
  const at = Date.parse(disk.measuredAt);
  return Number.isFinite(at) && now - at <= DISK_REPORT_FRESH_MS;
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
 * Why a failure happened when the disk is to blame (ADR 0335), or
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
