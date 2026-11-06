/** A boundary's persisted attempt clock, shared with returned calls (ADR 0295). */
export class BoundaryAttemptTimeoutError extends Error {
  constructor() {
    super("Boundary attempt exceeded its five-minute deadline");
    this.name = "BoundaryAttemptTimeoutError";
  }
}

export function requireAttemptTime(args: {
  signal: AbortSignal;
  deadlineAt: string;
}): void {
  args.signal.throwIfAborted();
  // Check the clock too: after a frozen process resumes its overdue timer may
  // not have run before a fulfilled promise's continuation.
  if (Date.parse(args.deadlineAt) <= Date.now())
    throw new BoundaryAttemptTimeoutError();
}

/** Stop awaiting an operation even when its implementation ignores cancellation. */
export async function runAbortable<T>(args: {
  signal: AbortSignal;
  deadlineAt: string;
  operation: () => Promise<T>;
}): Promise<T> {
  requireAttemptTime(args);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(args.signal.reason);
    args.signal.addEventListener("abort", abort, { once: true });
    // A callback may throw synchronously. Both promise outcomes are observed,
    // including a late rejection after cancellation has released the caller.
    void Promise.resolve()
      .then(() => {
        requireAttemptTime(args);
        return args.operation();
      })
      .then(resolve, reject)
      .finally(() => args.signal.removeEventListener("abort", abort));
  });
}
