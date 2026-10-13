import { WorkWakeups } from "@catamorphic/core";
import { afterEach, expect, it, vi } from "vitest";
import { startSessionChangeHints } from "./session-change-hints.js";

afterEach(() => {
  vi.useRealTimers();
});

it("sends one hint for a burst of session writes, after a quiet moment", async () => {
  vi.useFakeTimers();
  const wakeups = new WorkWakeups();
  const send = vi.fn();
  const hints = startSessionChangeHints({ wakeups, send });
  wakeups.notify("chats");
  wakeups.notify("chats");
  await vi.advanceTimersByTimeAsync(200);
  wakeups.notify("chats");
  expect(send).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(250);
  expect(send).toHaveBeenCalledTimes(1);
  // Other work, and streamed text alone, wake nothing here.
  wakeups.notify("execution");
  wakeups.notify("sessions");
  await vi.advanceTimersByTimeAsync(1_000);
  expect(send).toHaveBeenCalledTimes(1);
  hints.dispose();
});

it("never holds a hint back longer than its longest wait while changes keep coming", async () => {
  vi.useFakeTimers();
  const wakeups = new WorkWakeups();
  const send = vi.fn();
  const hints = startSessionChangeHints({ wakeups, send });
  for (let index = 0; index < 20; index += 1) {
    hints.hint();
    await vi.advanceTimersByTimeAsync(100);
  }
  expect(send).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(250);
  expect(send).toHaveBeenCalledTimes(2);
  hints.dispose();
  wakeups.notify("chats");
  await vi.advanceTimersByTimeAsync(5_000);
  expect(send).toHaveBeenCalledTimes(2);
});
