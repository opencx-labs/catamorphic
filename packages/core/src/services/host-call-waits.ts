import type { Json } from "@catamorphic/db";

/*
 * Host calls that outlive their attempt (ADR 0324). A host function that
 * started work it cannot finish within the boundary's five minutes (ADR
 * 0295) throws {@link HostCallParkedError} naming that work. The step then
 * waits like a pause, giving back the run's capacity (ADR 0289), and a
 * `host_call_wait` job asks the work's follower, a slice at a time, until
 * it ends; its result resolves the step as the call's own.
 */

/** The work a host call left running, by a key its follower knows. */
export class HostCallParkedError extends Error {
  constructor(readonly waitKey: string) {
    super(`Host call is waiting for ${waitKey}`);
    this.name = "HostCallParkedError";
  }
}

/** One slice of following parked work. */
export type HostCallFollowOutcome =
  /** Not ended; follow again, after `retryAfterMs` when given. */
  | { status: "pending"; retryAfterMs?: number }
  | { status: "done"; output: Json }
  | { status: "failed"; error: string };

/**
 * Follows the work `waitKey` names for at most `sliceMs`. Called again for
 * as long as it answers `pending`, from any replica.
 */
export type HostCallFollower = (args: {
  waitKey: string;
  signal: AbortSignal;
  sliceMs: number;
}) => Promise<HostCallFollowOutcome>;

/** Followers by the prefix of the keys they follow (`session-exec:`). */
export class HostCallFollowers {
  private readonly followers = new Map<string, HostCallFollower>();

  register(input: { prefix: string; follower: HostCallFollower }): void {
    this.followers.set(input.prefix, input.follower);
  }

  follow(args: {
    waitKey: string;
    signal: AbortSignal;
    sliceMs: number;
  }): Promise<HostCallFollowOutcome> {
    for (const [prefix, follower] of this.followers)
      if (args.waitKey.startsWith(prefix)) return follower(args);
    return Promise.resolve({
      status: "failed",
      error: "Nothing on this host follows this call",
    });
  }
}
