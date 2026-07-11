/**
 * Minimal object-storage contract the git origin needs. `S3ObjectStore` is
 * the production implementation; `InMemoryObjectStore` backs unit tests.
 *
 * Semantics implementations must honor:
 * - `put` with `ifNoneMatch: "*"` fails with {@link PreconditionFailedError}
 *   when the key already exists.
 * - `put` with `ifMatch` fails with {@link PreconditionFailedError} when the
 *   key is missing or its ETag differs. ETags are opaque — callers only pass
 *   back values previously returned by `get`.
 */
export interface ObjectStore {
  /** Read an object, or null when the key does not exist. */
  get(key: string): Promise<{ data: Uint8Array; etag: string } | null>;
  /** Whether the key exists (no body transfer). */
  has(key: string): Promise<boolean>;
  put(
    key: string,
    data: Uint8Array,
    opts?: { ifMatch?: string; ifNoneMatch?: "*" },
  ): Promise<void>;
  /** List full keys under a prefix. */
  list(prefix: string): Promise<string[]>;
  /** Delete every object under a prefix. */
  deletePrefix(prefix: string): Promise<void>;
}

/** A conditional `put` lost the race (HTTP 412 on S3-compatible stores). */
export class PreconditionFailedError extends Error {
  constructor(key: string) {
    super(`Conditional write failed for '${key}'`);
    this.name = "PreconditionFailedError";
  }
}
