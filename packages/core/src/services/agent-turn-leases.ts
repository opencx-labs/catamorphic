/** A turn this process claimed and is running (ADR 0193). */
export interface HeldTurnLease {
  turnId: string;
  leaseToken: string;
  /**
   * The lease can no longer be trusted: the database stopped naming this
   * process, or no renewal landed in time. Called at most once.
   */
  onLost(): void;
  /** Someone asked the turn to stop, through any replica. Called once. */
  onCancel(): void;
}

/** A renewal the database granted, and whether the turn should stop. */
export interface RenewedTurnLease {
  turnId: string;
  cancellationRequested: boolean;
}

/**
 * Keeps every turn lease this process holds, in one statement a second
 * (ADR 0193): `renew` extends the leases still owned and answers which
 * turns were asked to stop, so an interrupt sent to any replica reaches a
 * quiet turn within about a second. A turn missing from a renewal's answer
 * is lost at once; a turn whose last landed renewal was dispatched more
 * than `safeLeaseMs` ago (the database grants 60 seconds) is lost too, even
 * while a renewal hangs.
 */
export function startTurnLeaseRenewal(input: {
  renew: (
    turns: readonly HeldTurnLease[],
  ) => Promise<readonly RenewedTurnLease[]>;
  onError: (error: unknown) => void;
  intervalMs?: number;
  safeLeaseMs?: number;
}): {
  /** Keep this turn's lease until the returned function is called. */
  hold(turn: HeldTurnLease): () => void;
  stop(): void;
} {
  const intervalMs = input.intervalMs ?? 1_000;
  const safeLeaseMs = input.safeLeaseMs ?? 50_000;
  const held = new Map<
    string,
    { turn: HeldTurnLease; renewedAt: number; cancelled: boolean }
  >();
  let timer: ReturnType<typeof setInterval> | undefined;
  let renewing = false;
  let stopped = false;

  const drop = (turnId: string) => {
    held.delete(turnId);
    if (held.size === 0 && timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };
  const lose = (turnId: string) => {
    const entry = held.get(turnId);
    if (!entry) return;
    drop(turnId);
    entry.turn.onLost();
  };
  const tick = () => {
    const now = performance.now();
    for (const [turnId, entry] of held)
      if (now - entry.renewedAt >= safeLeaseMs) lose(turnId);
    if (renewing || held.size === 0) return;
    renewing = true;
    const dispatchedAt = performance.now();
    const snapshot = [...held.values()].map((entry) => entry.turn);
    void input
      .renew(snapshot)
      .then((renewed) => {
        const answers = new Map(renewed.map((row) => [row.turnId, row]));
        for (const turn of snapshot) {
          const entry = held.get(turn.turnId);
          if (!entry || entry.turn !== turn) continue;
          const answer = answers.get(turn.turnId);
          if (!answer) {
            lose(turn.turnId);
            continue;
          }
          entry.renewedAt = Math.max(entry.renewedAt, dispatchedAt);
          if (answer.cancellationRequested && !entry.cancelled) {
            entry.cancelled = true;
            entry.turn.onCancel();
          }
        }
      })
      // A brief database outage is not proof of lost ownership: the next
      // tick tries again, within the lease's deadline.
      .catch((error: unknown) => input.onError(error))
      .finally(() => {
        renewing = false;
      });
  };

  return {
    hold: (turn) => {
      if (stopped) throw new Error("Turn lease renewal has stopped");
      held.set(turn.turnId, {
        turn,
        renewedAt: performance.now(),
        cancelled: false,
      });
      if (!timer) {
        timer = setInterval(tick, intervalMs);
        timer.unref();
      }
      return () => {
        if (held.get(turn.turnId)?.turn === turn) drop(turn.turnId);
      };
    },
    stop: () => {
      stopped = true;
      held.clear();
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
