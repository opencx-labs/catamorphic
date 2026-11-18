import {
  describeDisk,
  diskLow,
  type MachineDisk,
  measureDisk,
  type SandboxProvider,
} from "@catamorphic/sandbox";

/** How often a machine measures its disk (ADR 0335). */
export const DISK_MEASURE_INTERVAL_MS = 30_000;
/** How often it removes what Work left that nothing uses. */
export const DISK_CLEAN_INTERVAL_MS = 60 * 60_000;
/** How soon it cleans again while it is under its floor. */
export const DISK_LOW_CLEAN_INTERVAL_MS = 10 * 60_000;

export interface DiskCare {
  /** The latest measurement, if any filesystem could be measured. */
  latest(): MachineDisk | undefined;
  /** Measure now; the first measurement is ready once this resolves. */
  measure(): Promise<MachineDisk | undefined>;
  stop(): void;
}

/**
 * A machine's care of its disk (ADR 0335): it measures its data folder and
 * the filesystems its provider writes to every 30 seconds, keeping the one
 * with the least room above its floor for the machine to report, and
 * removes what its provider left that nothing used for `graceMs`: once at
 * start, then hourly, and at once (at most every 10 minutes) while under
 * its floor.
 */
export function startDiskCare(args: {
  provider: Pick<SandboxProvider, "disk">;
  /** The machine's own data folder, always measured. */
  dataDir: string;
  /** `WORK_DISK_FLOOR_MB`; the default floor when absent. */
  floorMb?: number;
  /** `WORK_IMAGE_RETENTION_HOURS`, in milliseconds. */
  graceMs: number;
  measureEveryMs?: number;
  cleanEveryMs?: number;
  lowCleanEveryMs?: number;
  log?: (line: string) => void;
  /** For tests: measure as {@link measureDisk} does. */
  measureDisk?: typeof measureDisk;
}): DiskCare {
  const measure = args.measureDisk ?? measureDisk;
  let latest: MachineDisk | undefined;
  let wasLow = false;
  let stopped = false;
  let lastClean = Number.NEGATIVE_INFINITY;
  let cleaning: Promise<void> | undefined;
  const clean = (): void => {
    const run = args.provider.disk?.clean;
    if (!run || cleaning || stopped) return;
    lastClean = Date.now();
    cleaning = run({ graceMs: args.graceMs })
      .then((lines) => {
        for (const line of lines) args.log?.(line);
      })
      .catch((error: unknown) =>
        args.log?.(
          `Removing what Work left on this machine failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      )
      .finally(() => {
        cleaning = undefined;
      });
  };
  const once = async (): Promise<MachineDisk | undefined> => {
    const paths = [
      args.dataDir,
      ...((await args.provider.disk?.paths().catch(() => [])) ?? []),
    ];
    const measured = measure({
      paths,
      ...(args.floorMb !== undefined ? { floorMb: args.floorMb } : {}),
    });
    if (stopped) return latest;
    latest = measured;
    const low = measured ? diskLow(measured) : false;
    if (measured && low !== wasLow)
      args.log?.(
        low
          ? `This machine is short of disk (${describeDisk(measured)} at ${measured.path}); it takes no new workspaces until there is room`
          : `This machine has room on its disk again (${describeDisk(measured)})`,
      );
    wasLow = low;
    const due = low
      ? (args.lowCleanEveryMs ?? DISK_LOW_CLEAN_INTERVAL_MS)
      : (args.cleanEveryMs ?? DISK_CLEAN_INTERVAL_MS);
    if (Date.now() - lastClean >= due) clean();
    return measured;
  };
  let measuring: Promise<MachineDisk | undefined> | undefined;
  const measureNow = (): Promise<MachineDisk | undefined> => {
    measuring ??= once()
      .catch(() => latest)
      .finally(() => {
        measuring = undefined;
      });
    return measuring;
  };
  void measureNow();
  const timer = setInterval(
    () => void measureNow(),
    args.measureEveryMs ?? DISK_MEASURE_INTERVAL_MS,
  );
  timer.unref();
  return {
    latest: () => latest,
    measure: measureNow,
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
