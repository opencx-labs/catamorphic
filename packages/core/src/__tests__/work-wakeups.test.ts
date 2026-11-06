import { afterEach, expect, it, vi } from "vitest";
import { startEventDispatcher } from "../event-dispatcher.js";
import { startProjectEventMonitorWorker } from "../services/project-event-monitors-service.js";
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

const running = () => new AbortController().signal;

it("hints a key's waiters, once for a wakeup and for as long as a subscription lasts", async () => {
  const wakeups = new WorkWakeups<string>();
  const heard = vi.fn();
  const unsubscribe = wakeups.subscribe("executor", heard);
  const once = wakeups.next("executor");
  const cancelled = wakeups.next("executor");
  cancelled.cancel();
  expect(wakeups.notify("other")).toBe(0);
  expect(wakeups.notify("executor")).toBe(2);
  await expect(once.woken).resolves.toBeUndefined();
  expect(wakeups.notify("executor")).toBe(1);
  expect(heard).toHaveBeenCalledTimes(2);
  unsubscribe();
  expect(wakeups.notify("executor")).toBe(0);
});

it("polls at the quick cadence when the host sets no idle cadence", async () => {
  vi.useFakeTimers();
  const pacer = new PollPacer({ quickMs: 500, signal: running() });
  expect(pacer.quick).toBe(true);
  expect(await waited(pacer.wait())).toBe(500);
});

it("stays quick after work, then slows to the idle cadence", async () => {
  vi.useFakeTimers();
  const pacer = new PollPacer({
    quickMs: 500,
    idleMs: 5_000,
    signal: running(),
  });
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
    signal: running(),
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

it("hears a hint that arrives while a poll is in flight: the next wait is quick", async () => {
  vi.useFakeTimers();
  const wakeups = new WorkWakeups();
  const pacer = new PollPacer({
    quickMs: 500,
    idleMs: 5_000,
    signal: running(),
    wakeups,
    topic: "execution",
  });
  expect(pacer.quick).toBe(false);
  // Between two waits: the poller is reading Postgres.
  wakeups.notify("execution");
  expect(pacer.quick).toBe(true);
  expect(await waited(pacer.wait())).toBe(500);
});

it("never ends a quick wait early, so a run of hints polls no faster than its quick cadence", async () => {
  vi.useFakeTimers();
  const wakeups = new WorkWakeups();
  const pacer = new PollPacer({
    quickMs: 150,
    idleMs: 5_000,
    signal: running(),
    wakeups,
    topic: "sessions",
  });
  pacer.busy();
  const wait = pacer.wait();
  for (let hint = 0; hint < 5; hint += 1) {
    wakeups.notify("sessions");
    await vi.advanceTimersByTimeAsync(20);
  }
  expect(await waited(wait)).toBe(50);
});

it("ends an idle wait when known work falls due, never sooner than a quick one", async () => {
  vi.useFakeTimers();
  const pacer = new PollPacer({
    quickMs: 500,
    idleMs: 5_000,
    signal: running(),
  });
  expect(await waited(pacer.wait({ until: Date.now() + 2_000 }))).toBe(2_000);
  expect(await waited(pacer.wait({ until: Date.now() - 1_000 }))).toBe(500);
  expect(await waited(pacer.wait({ until: Date.now() + 60_000 }))).toBe(5_000);
});

it("ends a wait at once when its signal aborts, and stops hearing hints", async () => {
  vi.useFakeTimers();
  const wakeups = new WorkWakeups();
  const stop = new AbortController();
  const pacer = new PollPacer({
    quickMs: 500,
    idleMs: 5_000,
    signal: stop.signal,
    wakeups,
    topic: "agent",
  });
  const wait = pacer.wait();
  expect(wakeups.notify("agent")).toBe(1);
  stop.abort();
  expect(await waited(wait, 100)).toBe(0);
  expect(await waited(pacer.wait(), 100)).toBe(0);
  expect(wakeups.notify("agent")).toBe(0);
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

it("dispatches again soon when an event is recorded while a dispatch is in flight", async () => {
  vi.useFakeTimers();
  const wakeups = new WorkWakeups();
  let inFlight: (() => void) | undefined;
  const dispatchEvents = vi
    .fn()
    .mockResolvedValueOnce(0)
    // The second pass reads Postgres before the writer commits.
    .mockImplementationOnce(
      () =>
        new Promise<number>((resolve) => {
          inFlight = () => resolve(0);
        }),
    )
    .mockResolvedValue(0);
  const dispatcher = startEventDispatcher({
    core: { dispatchEvents, wakeups, idlePollMs: 30_000 },
  });
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(dispatchEvents).toHaveBeenCalledTimes(2);
  wakeups.notify("events");
  inFlight?.();
  await vi.advanceTimersByTimeAsync(999);
  expect(dispatchEvents).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(dispatchEvents).toHaveBeenCalledTimes(3);
  await dispatcher.stop();
});

it("polls a monitor when it falls due, and soon after a hint during a claim", async () => {
  vi.useFakeTimers();
  const wakeups = new WorkWakeups();
  let release: (() => void) | undefined;
  const claim = vi
    .fn()
    .mockResolvedValueOnce(null)
    .mockImplementationOnce(
      () =>
        new Promise<null>((resolve) => {
          release = () => resolve(null);
        }),
    )
    .mockResolvedValue(null);
  const nextDueAt = vi
    .fn()
    .mockResolvedValueOnce(new Date(Date.now() + 3_000))
    .mockResolvedValue(null);
  const worker = startProjectEventMonitorWorker({
    monitors: { claim, complete: vi.fn(), fail: vi.fn(), nextDueAt },
    providers: [],
    placement: "local",
    idlePollMs: 30_000,
    wakeups,
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(claim).toHaveBeenCalledTimes(1);
  expect(nextDueAt).toHaveBeenCalledWith({ placement: "local" });
  // Due in three seconds: polled then, not at the idle poll.
  await vi.advanceTimersByTimeAsync(2_999);
  expect(claim).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(claim).toHaveBeenCalledTimes(2);
  // A monitor ensured while that claim reads Postgres.
  wakeups.notify("events");
  release?.();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(claim).toHaveBeenCalledTimes(3);
  await worker.stop();
  expect(wakeups.notify("events")).toBe(0);
});
