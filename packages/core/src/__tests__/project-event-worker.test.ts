import { afterEach, expect, it, vi } from "vitest";
import { startProjectEventMonitorWorker } from "../services/project-event-monitors-service.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("recovers from a failed claim without overlapping or resurrecting after stop", async () => {
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const claim = vi
    .fn()
    .mockRejectedValueOnce(new Error("Database reconnecting"))
    .mockResolvedValue(null);
  const worker = startProjectEventMonitorWorker({
    monitors: { claim, complete: vi.fn(), fail: vi.fn() },
    providers: [],
    placement: "local",
  });
  await vi.advanceTimersByTimeAsync(1_000);
  expect(claim).toHaveBeenCalledTimes(2);
  await worker.stop();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(claim).toHaveBeenCalledTimes(2);
});

it("aborts and joins an in-flight source poll on shutdown", async () => {
  const claim = vi.fn().mockResolvedValue({
    id: "monitor",
    tenantId: "tenant",
    projectId: "project",
    sourceKind: "fixture",
    ownerExternalUserId: "owner",
    leaseToken: "lease",
  });
  const fail = vi.fn().mockResolvedValue(undefined);
  let pollSignal: AbortSignal | undefined;
  const worker = startProjectEventMonitorWorker({
    monitors: { claim, complete: vi.fn(), fail },
    placement: "local",
    providers: [
      {
        kind: "fixture",
        poll: async ({ signal }) => {
          pollSignal = signal;
          return new Promise((_resolve, reject) =>
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            }),
          );
        },
      },
    ],
  });
  try {
    await vi.waitFor(() => expect(pollSignal).toBeDefined());
    await worker.stop();
    expect(pollSignal?.aborted).toBe(true);
    expect(fail).toHaveBeenCalledWith(
      expect.objectContaining({ monitorId: "monitor", leaseToken: "lease" }),
    );
    expect(claim).toHaveBeenCalledTimes(1);
  } finally {
    await worker.stop();
  }
});
