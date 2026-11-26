import fs from "node:fs";
import path from "node:path";
import {
  type DiskFloorDefault,
  describeDisk,
  diskLow,
  type MachineDisk,
  measureDisk,
  type SandboxProvider,
} from "@catamorphic/sandbox";
import { z } from "zod";

/** How often a machine measures its disk (ADR 0336). */
export const DISK_MEASURE_INTERVAL_MS = 30_000;
/** How often it removes what Work left that nothing uses. */
export const DISK_CLEAN_INTERVAL_MS = 60 * 60_000;
/** How soon it cleans again while it is under its floor. */
export const DISK_LOW_CLEAN_INTERVAL_MS = 10 * 60_000;
/**
 * A machine that noted nothing for this long was not running: stopped
 * (ADR 0350), asleep or down. Its notes are 30 seconds apart.
 */
export const DISK_AWAY_AFTER_MS = 5 * 60_000;
/** The file in a machine's data folder where it notes that it runs. */
export const RUNNING_TIME_FILE = "running-time.json";

/** A stretch a machine was not running, in milliseconds since the epoch. */
export interface AwayStretch {
  from: number;
  to: number;
}

/**
 * How far back from `now` a machine must look to cover `ranMs` of the time
 * it ran: `ranMs`, and every stretch it was not running that falls inside.
 * A stretch that ended more than `ranMs` of running time ago adds nothing,
 * and one a clock that went back left ahead of `now` counts up to `now`.
 */
export function reachOfRunningTime(args: {
  ranMs: number;
  now: number;
  away: readonly AwayStretch[];
}): number {
  let left = args.ranMs;
  let cursor = args.now;
  for (const stretch of [...args.away].sort((a, b) => b.to - a.to)) {
    const to = Math.min(stretch.to, cursor);
    if (stretch.from >= to) continue;
    const ran = cursor - to;
    if (ran >= left) break;
    left -= ran;
    cursor = stretch.from;
  }
  return args.now - (cursor - left);
}

/** What a machine keeps of when it ran: its last note, and each stretch away. */
const RunningNotes = z.object({
  seenAt: z.number(),
  away: z.array(z.tuple([z.number(), z.number()])),
});

/**
 * When a machine was not running, kept in one small JSON file on the disk a
 * stop retains (ADR 0350). The machine notes that it runs every time it
 * looks at its disk; a note more than `awayAfterMs` after the one before
 * closes a stretch it was away. A machine that crashed left its last note,
 * so the time after it counts as away too. A machine without a file, or
 * whose clock went back, has no stretch to add: it starts from this note.
 */
class RunningTime {
  private seenAt: number | undefined;
  private away: AwayStretch[] = [];
  private failed = false;

  constructor(
    private readonly args: {
      file: string;
      /** Stretches older than this much running time are forgotten. */
      keepMs: number;
      awayAfterMs: number;
      now: () => number;
      log?: (line: string) => void;
    },
  ) {
    const notes = RunningNotes.safeParse(read(args.file)).data;
    if (!notes) return;
    this.seenAt = notes.seenAt;
    this.away = notes.away.map(([from, to]) => ({ from, to }));
  }

  /**
   * The machine runs now. Answers how far back `keepMs` of its running
   * time reaches.
   */
  note(): number {
    const now = this.args.now();
    if (this.seenAt !== undefined && now - this.seenAt > this.args.awayAfterMs)
      this.away.push({ from: this.seenAt, to: now });
    this.seenAt = now;
    const reach = reachOfRunningTime({
      ranMs: this.args.keepMs,
      now,
      away: this.away,
    });
    this.away = this.away.filter(
      (stretch) => stretch.to > now - reach && stretch.from < now,
    );
    try {
      fs.mkdirSync(path.dirname(this.args.file), { recursive: true });
      const temporary = `${this.args.file}.${process.pid}.tmp`;
      fs.writeFileSync(
        temporary,
        JSON.stringify({
          seenAt: this.seenAt,
          away: this.away.map((stretch) => [stretch.from, stretch.to]),
        }),
        { mode: 0o600 },
      );
      fs.renameSync(temporary, this.args.file);
      this.failed = false;
    } catch (error) {
      // Said once. The next start counts from the last note that was kept.
      if (!this.failed)
        this.args.log?.(
          `Could not note that this machine is running: ${error instanceof Error ? error.message : String(error)}`,
        );
      this.failed = true;
    }
    return reach;
  }
}

/** A JSON file's content, or undefined for one that is absent or unreadable. */
function read(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

export interface DiskCare {
  /** The latest measurement, if any filesystem could be measured. */
  latest(): MachineDisk | undefined;
  /** Measure now; the first measurement is ready once this resolves. */
  measure(): Promise<MachineDisk | undefined>;
  stop(): void;
}

/**
 * A machine's care of its disk (ADR 0336): it measures the filesystems its
 * provider writes to every 30 seconds (not the rest of its data folder,
 * such as a database, which Work's cleanup cannot free), keeping the one
 * with the least room above its floor for the machine to report, and
 * removes what its provider left that nothing used for `graceMs`: once at
 * start, then hourly, and at once (at most every 10 minutes) while under
 * its floor. With `runningFile`, `graceMs` is time the machine ran: a
 * stretch it was stopped (ADR 0350), asleep or down does not count against
 * what it keeps, so a machine resumed after days still has its images.
 */
export function startDiskCare(args: {
  provider: Pick<SandboxProvider, "disk">;
  /** `WORK_DISK_FLOOR_MB`; the default floor when absent. */
  floorMb?: number;
  /** `WORK_DISK_CRITICAL_MB`; the default critical floor when absent. */
  criticalMb?: number;
  /** The floor kept when `floorMb` is absent (ADR 0336); `workspaces` when absent. */
  defaultFloor?: DiskFloorDefault;
  /** `WORK_IMAGE_RETENTION_HOURS`, in milliseconds. */
  graceMs: number;
  /**
   * Where the machine notes that it runs, on the disk a stop retains.
   * Absent, or with a provider that removes nothing, all time counts as
   * running.
   */
  runningFile?: string;
  /** {@link DISK_AWAY_AFTER_MS} when absent. */
  awayAfterMs?: number;
  measureEveryMs?: number;
  cleanEveryMs?: number;
  lowCleanEveryMs?: number;
  log?: (line: string) => void;
  /** For tests: measure as {@link measureDisk} does. */
  measureDisk?: typeof measureDisk;
  /** The clock, for tests. */
  now?: () => number;
}): DiskCare {
  const measure = args.measureDisk ?? measureDisk;
  const running =
    args.runningFile && args.provider.disk?.clean
      ? new RunningTime({
          file: args.runningFile,
          keepMs: args.graceMs,
          awayAfterMs: args.awayAfterMs ?? DISK_AWAY_AFTER_MS,
          now: args.now ?? Date.now,
          ...(args.log ? { log: args.log } : {}),
        })
      : undefined;
  let latest: MachineDisk | undefined;
  let wasLow = false;
  let stopped = false;
  let lastClean = Number.NEGATIVE_INFINITY;
  let cleaning: Promise<void> | undefined;
  const clean = (): void => {
    const run = args.provider.disk?.clean;
    if (!run || cleaning || stopped) return;
    lastClean = Date.now();
    // Noted as it is read: a machine that slept through its last note
    // counts that stretch before it removes anything.
    cleaning = run({ graceMs: running?.note() ?? args.graceMs })
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
    const paths = (await args.provider.disk?.paths().catch(() => [])) ?? [];
    const measured = measure({
      paths,
      ...(args.floorMb !== undefined ? { floorMb: args.floorMb } : {}),
      ...(args.criticalMb !== undefined ? { criticalMb: args.criticalMb } : {}),
      ...(args.defaultFloor ? { defaultFloor: args.defaultFloor } : {}),
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
  running?.note();
  void measureNow();
  const timer = setInterval(() => {
    running?.note();
    void measureNow();
  }, args.measureEveryMs ?? DISK_MEASURE_INTERVAL_MS);
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
