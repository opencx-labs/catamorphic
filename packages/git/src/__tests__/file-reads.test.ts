import { describe, expect, it } from "vitest";
import { readFileSnapshot } from "../file-reads.js";

describe("bounded project snapshots", () => {
  it("bounds concurrent reads and waits for a failed batch to settle", async () => {
    let active = 0;
    let peak = 0;
    await expect(
      readFileSnapshot({
        paths: Array.from({ length: 100 }, (_, index) => String(index)),
        read: async (file) => {
          active++;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, 1));
          active--;
          if (file === "0") throw new Error("read failed");
          return file;
        },
      }),
    ).rejects.toThrow("read failed");
    expect(peak).toBeLessThanOrEqual(8);
    expect(active).toBe(0);
  });

  it("rejects oversized files and aggregate snapshots instead of truncating", async () => {
    await expect(
      readFileSnapshot({
        paths: ["a"],
        read: async () => "12345",
        options: { maxFileBytes: 4 },
      }),
    ).rejects.toThrow("snapshot limit");
    await expect(
      readFileSnapshot({
        paths: ["a", "b"],
        read: async () => "123",
        options: { maxTotalBytes: 4 },
      }),
    ).rejects.toThrow("snapshot exceeds");
  });
});
