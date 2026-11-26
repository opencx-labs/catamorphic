import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { MachineDisk } from "@catamorphic/sandbox";
import { afterEach, describe, expect, it } from "vitest";
import { reachOfRunningTime, startDiskCare } from "./disk-care.js";

/**
 * A machine's care of its disk (ADR 0336): it measures its provider's
 * filesystems, and cleans once at start, hourly, and sooner while under its
 * floor.
 */
describe("disk care", () => {
  const report = (free: number): MachineDisk => ({
    path: "/data",
    totalBytes: 100,
    freeBytes: free,
    floorBytes: 10,
    criticalBytes: 1,
    measuredAt: new Date().toISOString(),
  });

  it("measures only the provider's paths, and cleans sooner while short of disk", async () => {
    let free = 50;
    const measured: string[][] = [];
    const cleaned: number[] = [];
    const lines: string[] = [];
    const care = startDiskCare({
      provider: {
        disk: {
          paths: async () => ["/var/lib/docker"],
          clean: async ({ graceMs }) => {
            cleaned.push(graceMs);
            return ["Removed 1 unused image: example/review:1"];
          },
        },
      },
      floorMb: 0,
      graceMs: 1234,
      measureEveryMs: 60_000,
      cleanEveryMs: 60 * 60_000,
      lowCleanEveryMs: 0,
      log: (line) => lines.push(line),
      measureDisk: ({ paths }) => {
        measured.push([...paths]);
        return report(free);
      },
    });
    try {
      await care.measure();
      // Not the machine's whole data folder (a database there is not
      // Work's to free).
      expect(measured[0]).toEqual(["/var/lib/docker"]);
      expect(care.latest()?.freeBytes).toBe(50);
      // Once at start, with the grace it was given.
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(cleaned).toEqual([1234]);
      // With room, not again within the hour.
      await care.measure();
      expect(cleaned).toEqual([1234]);
      // Short of disk: said once, and cleaned again at once.
      free = 5;
      await care.measure();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(cleaned).toEqual([1234, 1234]);
      expect(lines.filter((line) => line.includes("short of disk"))).toEqual([
        "This machine is short of disk (5 bytes free of 100 bytes, where Work keeps 10 bytes free at /data); it takes no new workspaces until there is room",
      ]);
      expect(lines).toContain("Removed 1 unused image: example/review:1");
      free = 50;
      await care.measure();
      expect(lines.at(-1)).toMatch(/has room on its disk again/);
    } finally {
      care.stop();
    }
  });

  it("reports nothing for a machine whose filesystems cannot be measured", async () => {
    const care = startDiskCare({
      provider: {},
      graceMs: 0,
      measureDisk: () => undefined,
    });
    try {
      expect(await care.measure()).toBeUndefined();
      expect(care.latest()).toBeUndefined();
    } finally {
      care.stop();
    }
  });
});

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * What a machine keeps is kept for time it ran (ADR 0350): a stretch it was
 * stopped, asleep or down adds to how far back its cleanup looks.
 */
describe("running time", () => {
  const folders: string[] = [];
  afterEach(() => {
    for (const folder of folders.splice(0))
      fs.rmSync(folder, { recursive: true, force: true });
  });
  const runningFile = (): string => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), "disk-care-"));
    folders.push(folder);
    return path.join(folder, "running-time.json");
  };
  /** One start of a machine: the grace its cleanup at start was given. */
  const startedWith = async (args: {
    file: string;
    now: number;
    graceMs: number;
  }): Promise<number | undefined> => {
    const cleaned: number[] = [];
    const care = startDiskCare({
      provider: {
        disk: {
          paths: async () => [],
          clean: async ({ graceMs }) => {
            cleaned.push(graceMs);
            return [];
          },
        },
      },
      graceMs: args.graceMs,
      runningFile: args.file,
      measureEveryMs: HOUR,
      measureDisk: () => undefined,
      now: () => args.now,
    });
    try {
      await care.measure();
      await new Promise((resolve) => setTimeout(resolve, 10));
      return cleaned[0];
    } finally {
      care.stop();
    }
  };

  it("reaches back over the stretches a machine was not running", () => {
    const now = 100 * DAY;
    expect(reachOfRunningTime({ ranMs: DAY, now, away: [] })).toBe(DAY);
    // Stopped for two days, resumed an hour ago: a day of running time
    // ended 23 hours before the stop.
    expect(
      reachOfRunningTime({
        ranMs: DAY,
        now,
        away: [{ from: now - HOUR - 2 * DAY, to: now - HOUR }],
      }),
    ).toBe(3 * DAY);
    // A stretch that ended more than a day of running ago adds nothing.
    expect(
      reachOfRunningTime({
        ranMs: DAY,
        now,
        away: [{ from: now - 5 * DAY, to: now - DAY }],
      }),
    ).toBe(DAY);
    // Two stretches inside the day both count.
    expect(
      reachOfRunningTime({
        ranMs: DAY,
        now,
        away: [
          { from: now - 10 * HOUR, to: now - 8 * HOUR },
          { from: now - 3 * HOUR, to: now - HOUR },
        ],
      }),
    ).toBe(DAY + 4 * HOUR);
    // A clock that went back: a stretch ahead of it counts up to now, and
    // one wholly ahead does not count.
    expect(
      reachOfRunningTime({
        ranMs: DAY,
        now,
        away: [
          { from: now - HOUR, to: now + HOUR },
          { from: now + 2 * HOUR, to: now + 3 * HOUR },
        ],
      }),
    ).toBe(DAY + HOUR);
  });

  it("keeps the rule for a machine that runs, from its first start", async () => {
    const file = runningFile();
    const start = 100 * DAY;
    expect(await startedWith({ file, now: start, graceMs: DAY })).toBe(DAY);
    // A restart is not a stop.
    expect(
      await startedWith({ file, now: start + 2 * MINUTE, graceMs: DAY }),
    ).toBe(DAY);
  });

  it("does not count the time a machine was stopped, until it has run as long again", async () => {
    const file = runningFile();
    const grace = 10 * MINUTE;
    const stoppedAt = 100 * DAY;
    await startedWith({ file, now: stoppedAt, graceMs: grace });
    // Nothing is written at a stop, so a crash reads the same: the machine
    // was last seen running at its last note.
    const resumedAt = stoppedAt + 2 * DAY;
    expect(await startedWith({ file, now: resumedAt, graceMs: grace })).toBe(
      grace + 2 * DAY,
    );
    // Four and eight minutes of running later the stretch is still inside
    // its grace.
    expect(
      await startedWith({ file, now: resumedAt + 4 * MINUTE, graceMs: grace }),
    ).toBe(grace + 2 * DAY);
    expect(
      await startedWith({ file, now: resumedAt + 8 * MINUTE, graceMs: grace }),
    ).toBe(grace + 2 * DAY);
    // Once it ran its grace again, the stretch is forgotten.
    expect(
      await startedWith({ file, now: resumedAt + 12 * MINUTE, graceMs: grace }),
    ).toBe(grace);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({
      seenAt: resumedAt + 12 * MINUTE,
      away: [],
    });
  });

  it("adds nothing for a clock that went back or notes it cannot read", async () => {
    const file = runningFile();
    const now = 100 * DAY;
    fs.writeFileSync(file, JSON.stringify({ seenAt: now + DAY, away: [] }));
    expect(await startedWith({ file, now, graceMs: DAY })).toBe(DAY);
    fs.writeFileSync(file, "not json");
    expect(await startedWith({ file, now: now + DAY, graceMs: DAY })).toBe(DAY);
  });
});
