import { describe, expect, it } from "vitest";
import { waitUntil } from "./wait.js";

describe("waitUntil", () => {
  it("returns as soon as it is ready", async () => {
    let checks = 0;
    const outcome = await waitUntil({
      ready: () => ++checks >= 3,
      timeoutMs: 10_000,
      stopWaiting: new AbortController().signal,
      pollMs: 1,
    });
    expect(outcome).toBe("ready");
    expect(checks).toBe(3);
  });

  it("stops the moment something reaches the agent, without waiting out its poll", async () => {
    const stop = new AbortController();
    const started = Date.now();
    setTimeout(() => stop.abort(), 20);
    const outcome = await waitUntil({
      ready: () => false,
      timeoutMs: 10_000,
      stopWaiting: stop.signal,
      pollMs: 5_000,
    });
    expect(outcome).toBe("stopped");
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("does not wait at all once stopped, but still reports what is ready", async () => {
    const stop = new AbortController();
    stop.abort();
    expect(
      await waitUntil({
        ready: () => false,
        timeoutMs: 10_000,
        stopWaiting: stop.signal,
      }),
    ).toBe("stopped");
    expect(
      await waitUntil({
        ready: () => true,
        timeoutMs: 10_000,
        stopWaiting: stop.signal,
      }),
    ).toBe("ready");
  });

  it("times out", async () => {
    expect(
      await waitUntil({
        ready: () => false,
        timeoutMs: 30,
        stopWaiting: new AbortController().signal,
        pollMs: 10,
      }),
    ).toBe("timeout");
  });
});
