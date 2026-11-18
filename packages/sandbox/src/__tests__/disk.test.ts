import os from "node:os";
import { describe, expect, it } from "vitest";
import {
  diskBudgetMb,
  diskCriticalBytes,
  diskFloorBytes,
  diskFresh,
  diskLow,
  diskRecovered,
  type MachineDisk,
  measureDisk,
  outOfDiskReason,
  saysOutOfDisk,
} from "../disk.js";

const GIB = 1024 ** 3;
const at = "2026-11-18T10:00:00.000Z";

const disk = (free: number, total = 100 * GIB, floor = 10 * GIB) =>
  ({
    path: "/var/lib/docker",
    totalBytes: total,
    freeBytes: free,
    floorBytes: floor,
    criticalBytes: Math.min(floor, GIB),
    measuredAt: at,
  }) satisfies MachineDisk;

describe("machine disk (ADR 0335)", () => {
  it("keeps 10% of a filesystem free by default, at most 10 GiB, or what the operator sets", () => {
    expect(diskFloorBytes({ totalBytes: 50 * GIB })).toBe(5 * GIB);
    expect(diskFloorBytes({ totalBytes: 1000 * GIB })).toBe(10 * GIB);
    expect(diskFloorBytes({ totalBytes: 50 * GIB, floorMb: 2048 })).toBe(
      2 * GIB,
    );
    expect(diskFloorBytes({ totalBytes: 50 * GIB, floorMb: 0 })).toBe(0);
  });

  it("keeps a lower critical floor for workflow runs: 1%, at most 1 GiB, never above the floor", () => {
    expect(
      diskCriticalBytes({ totalBytes: 50 * GIB, floorBytes: 5 * GIB }),
    ).toBe(Math.floor(50 * GIB * 0.01));
    expect(
      diskCriticalBytes({ totalBytes: 1000 * GIB, floorBytes: 10 * GIB }),
    ).toBe(GIB);
    expect(
      diskCriticalBytes({
        totalBytes: 50 * GIB,
        floorBytes: 5 * GIB,
        criticalMb: 2048,
      }),
    ).toBe(2 * GIB);
    // Never above the floor, and 0 with none.
    expect(diskCriticalBytes({ totalBytes: 1000 * GIB, floorBytes: 0 })).toBe(
      0,
    );
  });

  it("reports the filesystem with the least room above its floor, each device once", () => {
    const filesystems: Record<
      string,
      { dev: number; blocks: number; bavail: number }
    > = {
      // 100 GiB with 30 free: 20 above its 10 GiB floor.
      "/data": { dev: 1, blocks: 100 * 1024, bavail: 30 * 1024 },
      // The same device again: measured once.
      "/data/container": { dev: 1, blocks: 100 * 1024, bavail: 0 },
      // 40 GiB with 8 free: 4 above its 4 GiB floor, the tightest.
      "/var/lib/docker": { dev: 2, blocks: 40 * 1024, bavail: 8 * 1024 },
    };
    const measured = measureDisk({
      paths: ["/data", "/data/container", "/missing", "/var/lib/docker"],
      now: new Date(at),
      device: (path) => {
        const entry = filesystems[path];
        if (!entry) throw new Error("ENOENT");
        return entry.dev;
      },
      statfs: (path) => {
        const entry = filesystems[path];
        if (!entry) throw new Error("ENOENT");
        return {
          bsize: 1024 * 1024,
          blocks: entry.blocks,
          bavail: entry.bavail,
        };
      },
    });
    expect(measured).toEqual({
      path: "/var/lib/docker",
      totalBytes: 40 * GIB,
      freeBytes: 8 * GIB,
      floorBytes: 4 * GIB,
      criticalBytes: Math.floor(40 * GIB * 0.01),
      measuredAt: at,
    });
    expect(
      measureDisk({
        paths: ["/missing"],
        device: () => {
          throw new Error("ENOENT");
        },
      }),
    ).toBeUndefined();
  });

  it("measures this machine's own temporary folder", () => {
    const measured = measureDisk({ paths: [os.tmpdir()] });
    expect(measured?.totalBytes).toBeGreaterThan(0);
    expect(measured?.freeBytes).toBeLessThanOrEqual(measured?.totalBytes ?? 0);
  });

  it("is low under its floor, recovered only well above it, and budgets its total less its floor", () => {
    expect(diskLow(disk(9 * GIB))).toBe(true);
    expect(diskLow(disk(10 * GIB))).toBe(false);
    // No floor, never low.
    expect(diskLow(disk(0, 100 * GIB, 0))).toBe(false);
    expect(diskRecovered(disk(10.5 * GIB))).toBe(false);
    expect(diskRecovered(disk(11 * GIB))).toBe(true);
    expect(diskBudgetMb(disk(50 * GIB))).toBe(90 * 1024);
    expect(diskFresh(disk(1), Date.parse(at) + 4 * 60_000)).toBe(true);
    expect(diskFresh(disk(1), Date.parse(at) + 6 * 60_000)).toBe(false);
  });

  it("names a full disk from the machine's own report, and treats output as a hint", () => {
    expect(saysOutOfDisk("npm ERR! code ENOSPC")).toBe(true);
    expect(
      saysOutOfDisk("write /var/lib/docker/tmp: no space left on device"),
    ).toBe(true);
    expect(saysOutOfDisk("Error: ENOENT: no such file")).toBe(false);
    expect(outOfDiskReason({ disk: disk(2e9), texts: [] })).toBe(
      "The machine ran out of disk: 2.0 GB free of 107 GB, where Work keeps 10.7 GB free.",
    );
    expect(outOfDiskReason({ disk: disk(50 * GIB), texts: ["ENOSPC"] })).toBe(
      "The workspace ran out of disk space (no space left on device); the machine reports 53.7 GB free of 107 GB, where Work keeps 10.7 GB free.",
    );
    expect(outOfDiskReason({ texts: ["No space left on device"] })).toBe(
      "The workspace ran out of disk space (no space left on device).",
    );
    expect(
      outOfDiskReason({ disk: disk(50 * GIB), texts: ["exit 1"] }),
    ).toBeUndefined();
  });
});
