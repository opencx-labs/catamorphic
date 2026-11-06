/**
 * A compare-and-swap ref update or delete lost its race: the ref no longer
 * holds the value the caller read. Callers re-read and retry.
 */
export class RefMovedError extends Error {
  readonly ref: string;
  constructor(input: {
    ref: string;
    expected: string | null;
    actual: string | null;
  }) {
    super(
      `Ref ${input.ref} moved (expected ${input.expected ?? "none"}, got ${input.actual ?? "none"})`,
    );
    this.name = "RefMovedError";
    this.ref = input.ref;
  }
}
