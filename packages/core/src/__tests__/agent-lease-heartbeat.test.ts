import { afterEach, describe, expect, it, vi } from "vitest";
import { startAgentLeaseHeartbeat } from "../services/agent-lease-heartbeat.js";

describe("agent execution lease heartbeat", () => {
  afterEach(() => vi.useRealTimers());

  it("retries a brief outage without interrupting or overlapping renewals", async () => {
    vi.useFakeTimers();
    const renew = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(true);
    const onLost = vi.fn();
    const heartbeat = startAgentLeaseHeartbeat({
      renew,
      onLost,
      onError: vi.fn(),
    });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(renew).toHaveBeenCalledTimes(1);
    expect(onLost).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(renew).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(35_000);
    expect(onLost).not.toHaveBeenCalled();
    heartbeat.stop();
  });

  it("stops before ownership expires even if renewal never answers", async () => {
    vi.useFakeTimers();
    const renew = vi.fn(() => new Promise<boolean>(() => {}));
    const onLost = vi.fn();
    startAgentLeaseHeartbeat({ renew, onLost, onError: vi.fn() });
    await vi.advanceTimersByTimeAsync(50_000);
    expect(renew).toHaveBeenCalledTimes(1);
    expect(onLost).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100_000);
    expect(onLost).toHaveBeenCalledTimes(1);
  });

  it("does not resurrect a stopped heartbeat when an in-flight renewal returns", async () => {
    vi.useFakeTimers();
    let respond: (owned: boolean) => void = () => {};
    const renew = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          respond = resolve;
        }),
    );
    const onLost = vi.fn();
    const heartbeat = startAgentLeaseHeartbeat({
      renew,
      onLost,
      onError: vi.fn(),
    });
    await vi.advanceTimersByTimeAsync(15_000);
    heartbeat.stop();
    respond(true);
    await vi.advanceTimersByTimeAsync(100_000);
    expect(renew).toHaveBeenCalledTimes(1);
    expect(onLost).not.toHaveBeenCalled();
  });
});
