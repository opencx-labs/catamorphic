/** Renew ownership independently of provider activity and client connections. */
export function startAgentLeaseHeartbeat(input: {
  renew: () => Promise<boolean>;
  onLost: () => void;
  onError: (error: unknown) => void;
}): { stop(): void } {
  // The database grants 60 seconds. Stop before that deadline, including if
  // a renewal hangs. Measure from dispatch, not the potentially late response.
  const safeLeaseMs = 50_000;
  let stopped = false;
  let renewal: ReturnType<typeof setTimeout> | undefined;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    stopped = true;
    clearTimeout(renewal);
    clearTimeout(expiry);
  };
  const lost = () => {
    if (stopped) return;
    stop();
    input.onLost();
  };
  const armExpiry = (remainingMs: number) => {
    clearTimeout(expiry);
    expiry = setTimeout(lost, Math.max(0, remainingMs));
    expiry.unref();
  };
  const schedule = (delay: number) => {
    renewal = setTimeout(() => void renew(), delay);
    renewal.unref();
  };
  const renew = async () => {
    const startedAt = performance.now();
    try {
      const owned = await input.renew();
      if (stopped) return;
      if (!owned) {
        lost();
        return;
      }
      const remaining = safeLeaseMs - (performance.now() - startedAt);
      if (remaining <= 0) {
        lost();
        return;
      }
      armExpiry(remaining);
      schedule(15_000);
    } catch (error) {
      if (stopped) return;
      input.onError(error);
      // A brief DB outage is not proof of lost ownership. Retry renewal
      // within the existing deadline, without issuing another agent turn.
      schedule(1_000);
    }
  };
  armExpiry(safeLeaseMs);
  schedule(15_000);
  return { stop };
}
