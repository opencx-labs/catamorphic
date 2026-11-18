import type { MachineDisk } from "@catamorphic/sandbox";
import { describe, expect, it } from "vitest";
import { startDiskCare } from "./disk-care.js";

/**
 * A machine's care of its disk (ADR 0335): it measures its data folder and
 * its provider's filesystems, and cleans once at start, hourly, and sooner
 * while under its floor.
 */
describe("disk care", () => {
  const report = (free: number): MachineDisk => ({
    path: "/data",
    totalBytes: 100,
    freeBytes: free,
    floorBytes: 10,
    measuredAt: new Date().toISOString(),
  });

  it("measures the data folder and the provider's paths, and cleans sooner while short of disk", async () => {
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
      dataDir: "/data",
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
      expect(measured[0]).toEqual(["/data", "/var/lib/docker"]);
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
      dataDir: "/data",
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
