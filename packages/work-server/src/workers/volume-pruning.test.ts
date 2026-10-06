import { expect, it, vi } from "vitest";
import { startVolumePruning } from "./volume-pruning.js";

it("prunes volumes unused past retention at start and on its interval (ADR 0208)", async () => {
  const calls: number[] = [];
  const log: string[] = [];
  const stop = startVolumePruning({
    provider: {
      volumes: {
        prune: async ({ unusedForMs }) => {
          calls.push(unusedForMs);
          return calls.length === 1 ? ["cache-0123456789abcdef01234567"] : [];
        },
        removeAll: async () => {},
      },
    },
    retentionMs: 30 * 24 * 60 * 60 * 1000,
    intervalMs: 20,
    log: (line) => log.push(line),
  });
  try {
    await vi.waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(2), {
      timeout: 5_000,
    });
    expect(calls[0]).toBe(30 * 24 * 60 * 60 * 1000);
    expect(log).toEqual([
      "Removed 1 unused volume: cache-0123456789abcdef01234567",
    ]);
  } finally {
    stop();
  }
  const after = calls.length;
  await new Promise((resolve) => setTimeout(resolve, 100));
  // A pass already in flight may still land; no new one starts.
  expect(calls.length).toBeLessThanOrEqual(after + 1);
});

it("logs a failed pass and does nothing on a machine without volumes", async () => {
  const log: string[] = [];
  const stop = startVolumePruning({
    provider: {
      volumes: {
        prune: async () => {
          throw new Error("daemon away");
        },
        removeAll: async () => {},
      },
    },
    retentionMs: 1,
    log: (line) => log.push(line),
  });
  await vi.waitFor(() =>
    expect(log).toEqual(["Pruning unused volumes failed: daemon away"]),
  );
  stop();
  expect(startVolumePruning({ provider: {}, retentionMs: 1 })).toBeTypeOf(
    "function",
  );
});
