import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createUpdatePreparation } from "./update-preparation.js";

describe("native update preparation", () => {
  it("times out without leaving a callback that can restart later", async () => {
    vi.useFakeTimers();
    const updater = Object.assign(new EventEmitter(), {
      checkForUpdates: vi.fn(),
    });
    const preparation = createUpdatePreparation({ updater, timeoutMs: 100 });
    try {
      const result = expect(preparation.prepare()).rejects.toThrow("timed out");
      await vi.advanceTimersByTimeAsync(100);
      await result;
      expect(updater.listenerCount("error")).toBe(0);
      // Only the readiness observer remains; a late completion cannot quit.
      expect(updater.listenerCount("update-downloaded")).toBe(1);
      updater.emit("update-downloaded");
      await preparation.prepare();
      expect(updater.checkForUpdates).toHaveBeenCalledOnce();
    } finally {
      preparation.dispose();
      vi.useRealTimers();
    }
  });
  it("removes attempt listeners after failure and permits an explicit retry", async () => {
    const updater = Object.assign(new EventEmitter(), {
      checkForUpdates: vi.fn(),
    });
    const preparation = createUpdatePreparation({ updater });
    const first = expect(preparation.prepare()).rejects.toThrow("failed");
    updater.emit("error", new Error("failed"));
    await first;
    const second = preparation.prepare();
    updater.emit("update-downloaded");
    await second;
    preparation.dispose();
    expect(updater.listenerCount("update-downloaded")).toBe(0);
  });
});
