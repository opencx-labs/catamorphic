import { afterEach, expect, it, vi } from "vitest";
import { startEventDispatcher } from "../event-dispatcher.js";
import {
  PollPacer,
  QUICK_FOR_MS,
  WorkWakeups,
} from "../services/work-wakeups.js";

afterEach(() => {
  vi.useRealTimers();
});

/** Resolves to how long `pacer.wait()` took on fake timers. */
async function waited(
  wait: Promise<void>,
  limitMs = 120_000,
): Promise<number | "pending"> {
  let done = false;
  void wait.then(() => {
    done = true;
  });
  const start = Date.now();
  for (let step = 0; step <= limitMs / 50; step += 1) {
    await vi.advanceTimersByTimeAsync(0);
    if (done) return Date.now() - start;
    await vi.advanceTimersByTimeAsync(50);
  }
  return "pending";
}

it("polls at the quick cadence when the host sets no idle cadence", async () => {
  vi.useFakeTimers();
  const pacer = new PollPacer({ quickMs: 500 });
  expect(pacer.quick).toBe(true);
  expect(await waited(pacer.wait())).toBe(500);
});

it("stays quick after work, then slows to the idle cadence", async () => {
  vi.useFakeTimers();
  const pacer = new PollPacer({ quickMs: 500, idleMs: 5_000 });
  expect(await waited(pacer.wait())).toBe(5_000);
  pacer.busy();
  expect(await waited(pacer.wait())).toBe(500);
  await vi.advanceTimersByTimeAsync(QUICK_FOR_MS);
  expect(pacer.quick).toBe(false);
  expect(await waited(pacer.wait())).toBe(5_000);
});

it("wakes an idle wait on a hint for its topic only, and stays quick after", async () => {
  vi.useFakeTimers();
  const wakeups = new WorkWakeups();
  const pacer = new PollPacer({
    quickMs: 150,
    idleMs: 5_000,
    wakeups,
    topic: "sessions",
  });
  const wait = pacer.wait();
  await vi.advanceTimersByTimeAsync(1_000);
  wakeups.notify("execution");
  await vi.advanceTimersByTimeAsync(0);
  expect(await waited(wait, 100)).toBe("pending");
  wakeups.notify("sessions");
  expect(await waited(wait, 100)).toBe(0);
  // The hint may precede its writer's commit: the next polls are quick.
  expect(pacer.quick).toBe(true);
  expect(await waited(pacer.wait())).toBe(150);
});

it("ends an idle wait when known work falls due, never sooner than a quick one", async () => {
  vi.useFakeTimers();
  const pacer = new PollPacer({ quickMs: 500, idleMs: 5_000 });
  expect(
    await waited(pacer.wait(undefined, { until: Date.now() + 2_000 })),
  ).toBe(2_000);
  expect(
    await waited(pacer.wait(undefined, { until: Date.now() - 1_000 })),
  ).toBe(500);
  expect(
    await waited(pacer.wait(undefined, { until: Date.now() + 60_000 })),
  ).toBe(5_000);
});

it("ends a wait at once when its signal aborts", async () => {
  vi.useFakeTimers();
  const wakeups = new WorkWakeups();
  const pacer = new PollPacer({
    quickMs: 500,
    idleMs: 5_000,
    wakeups,
    topic: "agent",
  });
  const stop = new AbortController();
  const wait = pacer.wait(stop.signal);
  stop.abort();
  expect(await waited(wait, 100)).toBe(0);
  expect(await waited(pacer.wait(stop.signal), 100)).toBe(0);
});

it("dispatches an event recorded in this process without waiting for the idle poll", async () => {
  vi.useFakeTimers();
  const wakeups = new WorkWakeups();
  const dispatchEvents = vi.fn().mockResolvedValue(0);
  const dispatcher = startEventDispatcher({
    core: { dispatchEvents, wakeups, idlePollMs: 30_000 },
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(dispatchEvents).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(dispatchEvents).toHaveBeenCalledTimes(1);
  wakeups.notify("events");
  await vi.advanceTimersByTimeAsync(0);
  expect(dispatchEvents).toHaveBeenCalledTimes(2);
  // Quick for a moment after the hint (the write may not have committed).
  await vi.advanceTimersByTimeAsync(1_000);
  expect(dispatchEvents).toHaveBeenCalledTimes(3);
  await dispatcher.stop();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(dispatchEvents).toHaveBeenCalledTimes(3);
});
