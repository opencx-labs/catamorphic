import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type HeldTurnLease,
  startTurnLeaseRenewal,
} from "../services/agent-turn-leases.js";

function held(turnId: string) {
  return {
    turnId,
    leaseToken: `${turnId}-token`,
    onLost: vi.fn<() => void>(),
    onCancel: vi.fn<() => void>(),
  } satisfies HeldTurnLease;
}

describe("turn lease renewal (ADR 0193)", () => {
  afterEach(() => vi.useRealTimers());

  it("renews every held turn in one call a second and delivers stops once", async () => {
    vi.useFakeTimers();
    let cancelled = false;
    const renew = vi.fn(async (turns: readonly HeldTurnLease[]) =>
      turns.map((turn) => ({
        turnId: turn.turnId,
        cancellationRequested: cancelled && turn.turnId === "b",
      })),
    );
    const leases = startTurnLeaseRenewal({ renew, onError: vi.fn() });
    const a = held("a");
    const b = held("b");
    leases.hold(a);
    leases.hold(b);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(renew).toHaveBeenCalledTimes(1);
    expect(renew.mock.calls[0]?.[0].map((turn) => turn.turnId)).toEqual([
      "a",
      "b",
    ]);
    cancelled = true;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(b.onCancel).toHaveBeenCalledTimes(1);
    expect(a.onCancel).not.toHaveBeenCalled();
    expect(a.onLost).not.toHaveBeenCalled();
    leases.stop();
  });

  it("loses a turn the database no longer names, at once", async () => {
    vi.useFakeTimers();
    const renew = vi.fn(async (turns: readonly HeldTurnLease[]) =>
      turns
        .filter((turn) => turn.turnId !== "gone")
        .map((turn) => ({ turnId: turn.turnId, cancellationRequested: false })),
    );
    const leases = startTurnLeaseRenewal({ renew, onError: vi.fn() });
    const kept = held("kept");
    const gone = held("gone");
    leases.hold(kept);
    leases.hold(gone);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(gone.onLost).toHaveBeenCalledTimes(1);
    expect(kept.onLost).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(renew.mock.calls[1]?.[0].map((turn) => turn.turnId)).toEqual([
      "kept",
    ]);
    leases.stop();
  });

  it("rides out a brief outage without losing its turns", async () => {
    vi.useFakeTimers();
    let offline = true;
    const onError = vi.fn();
    const renew = vi.fn(async (turns: readonly HeldTurnLease[]) => {
      if (offline) throw new Error("offline");
      return turns.map((turn) => ({
        turnId: turn.turnId,
        cancellationRequested: false,
      }));
    });
    const leases = startTurnLeaseRenewal({ renew, onError });
    const turn = held("a");
    leases.hold(turn);
    await vi.advanceTimersByTimeAsync(30_000);
    offline = false;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(onError).toHaveBeenCalled();
    expect(turn.onLost).not.toHaveBeenCalled();
    leases.stop();
  });

  it("stops before the lease expires even if renewal never answers", async () => {
    vi.useFakeTimers();
    const renew = vi.fn(() => new Promise<never>(() => {}));
    const leases = startTurnLeaseRenewal({ renew, onError: vi.fn() });
    const turn = held("a");
    leases.hold(turn);
    await vi.advanceTimersByTimeAsync(50_000);
    expect(renew).toHaveBeenCalledTimes(1);
    expect(turn.onLost).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100_000);
    expect(turn.onLost).toHaveBeenCalledTimes(1);
    leases.stop();
  });

  it("forgets a released turn and never renews it again", async () => {
    vi.useFakeTimers();
    const renew = vi.fn(async (turns: readonly HeldTurnLease[]) =>
      turns.map((turn) => ({
        turnId: turn.turnId,
        cancellationRequested: false,
      })),
    );
    const leases = startTurnLeaseRenewal({ renew, onError: vi.fn() });
    const turn = held("a");
    const release = leases.hold(turn);
    await vi.advanceTimersByTimeAsync(1_000);
    release();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(renew).toHaveBeenCalledTimes(1);
    expect(turn.onLost).not.toHaveBeenCalled();
    leases.stop();
  });
});
