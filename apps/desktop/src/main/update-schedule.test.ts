import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UpdateSchedule } from "./update-schedule.js";

const HOUR = 60 * 60_000;

beforeEach(() => {
  vi.useFakeTimers({ now: new Date("2026-10-02T09:00:00Z") });
});
afterEach(() => {
  vi.useRealTimers();
});

function schedule(answers: boolean[] = []) {
  const check = vi.fn(async () => answers.shift() ?? true);
  const value = new UpdateSchedule({ check });
  value.start();
  return { check, value };
}

describe("UpdateSchedule", () => {
  it("checks shortly after launch, then every six hours", async () => {
    const { check, value } = schedule();
    await vi.advanceTimersByTimeAsync(29_000);
    expect(check).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(check).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(6 * HOUR - 6 * 60_000);
    expect(check).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(check).toHaveBeenCalledTimes(2);
    value.dispose();
  });

  it("counts time asleep: a wake after six hours checks a minute later", async () => {
    const { check, value } = schedule();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(check).toHaveBeenCalledTimes(1);
    // Asleep overnight: the wall clock moves, timers do not fire.
    vi.setSystemTime(Date.now() + 10 * HOUR);
    value.resumed();
    await vi.advanceTimersByTimeAsync(59_000);
    expect(check).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(check).toHaveBeenCalledTimes(2);
    // A short nap after that does not check again.
    vi.setSystemTime(Date.now() + HOUR);
    value.resumed();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(check).toHaveBeenCalledTimes(2);
    value.dispose();
  });

  it("retries a failed check soon instead of in six hours", async () => {
    const { check, value } = schedule([false, false, true]);
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(check).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(check).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(5 * HOUR);
    expect(check).toHaveBeenCalledTimes(3);
    value.dispose();
  });

  it("counts a manual check and stops after dispose", async () => {
    const { check, value } = schedule();
    value.checked(true);
    await vi.advanceTimersByTimeAsync(5 * HOUR);
    expect(check).not.toHaveBeenCalled();
    value.dispose();
    await vi.advanceTimersByTimeAsync(2 * HOUR);
    expect(check).not.toHaveBeenCalled();
  });
});
