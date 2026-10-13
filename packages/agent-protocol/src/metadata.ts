import type { JsonValue, SessionMetadata } from "./model.js";

/**
 * Bounds that keep a session's metadata a few facts about the session, not
 * a store (ADR 0225). Every writer enforces them; a client may check first.
 */
export const SESSION_METADATA_LIMITS = {
  /** Keys one session holds. */
  keys: 32,
  /** Characters in a key. */
  keyLength: 64,
  /** UTF-8 bytes of one value, written as JSON. */
  valueBytes: 16_384,
  /** UTF-8 bytes of all of a session's metadata, written as JSON. */
  totalBytes: 65_536,
  /** Arrays and objects nested inside one value. */
  depth: 16,
} as const;

/**
 * A key: lowercase words of letters and digits joined by `_`, `-` or `.`,
 * starting with a letter (`pull_requests`, `deploy.preview`).
 */
export const SESSION_METADATA_KEY_PATTERN =
  /^[a-z][a-z0-9]*(?:[_.-][a-z0-9]+)*$/;

/** A metadata write the rules refuse. Nothing was changed. */
export class SessionMetadataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionMetadataError";
  }
}

/**
 * A session's metadata after a write: each key of `values` takes its value,
 * and a null value removes the key. Returns `current` itself when the write
 * changes nothing. Throws {@link SessionMetadataError} for a malformed key
 * or value, or a result beyond {@link SESSION_METADATA_LIMITS}.
 */
export function withSessionMetadata(
  current: SessionMetadata,
  values: Readonly<Record<string, JsonValue>>,
): SessionMetadata {
  const entries = Object.entries(values);
  if (entries.length === 0)
    throw new SessionMetadataError("Name at least one key to set or remove.");
  if (entries.length > SESSION_METADATA_LIMITS.keys)
    throw new SessionMetadataError(
      `A write sets at most ${SESSION_METADATA_LIMITS.keys} keys.`,
    );
  const next: SessionMetadata = { ...current };
  let changed = false;
  for (const [key, value] of entries) {
    if (
      key.length > SESSION_METADATA_LIMITS.keyLength ||
      !SESSION_METADATA_KEY_PATTERN.test(key)
    )
      throw new SessionMetadataError(
        `"${key.slice(0, 80)}" is not a metadata key: use lowercase words of letters and digits joined by _, - or ., at most ${SESSION_METADATA_LIMITS.keyLength} characters, starting with a letter.`,
      );
    if (value === null) {
      if (Object.hasOwn(next, key)) {
        delete next[key];
        changed = true;
      }
      continue;
    }
    checkValue(key, value, 0);
    if (jsonBytes(value) > SESSION_METADATA_LIMITS.valueBytes)
      throw new SessionMetadataError(
        `The value of ${key} is larger than ${SESSION_METADATA_LIMITS.valueBytes} bytes as JSON.`,
      );
    const before = Object.hasOwn(next, key) ? next[key] : undefined;
    if (before !== undefined && sameJson(before, value)) continue;
    next[key] = value;
    changed = true;
  }
  if (!changed) return current;
  if (Object.keys(next).length > SESSION_METADATA_LIMITS.keys)
    throw new SessionMetadataError(
      `A session holds at most ${SESSION_METADATA_LIMITS.keys} metadata keys; remove one first.`,
    );
  if (jsonBytes(next) > SESSION_METADATA_LIMITS.totalBytes)
    throw new SessionMetadataError(
      `A session's metadata is at most ${SESSION_METADATA_LIMITS.totalBytes} bytes as JSON; remove or shorten a value first.`,
    );
  return next;
}

/** Plain JSON only: finite numbers, plain objects, bounded nesting. */
function checkValue(key: string, value: unknown, depth: number): void {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return;
    throw new SessionMetadataError(`The value of ${key} holds a non-number.`);
  }
  if (typeof value !== "object")
    throw new SessionMetadataError(`The value of ${key} is not JSON.`);
  if (depth >= SESSION_METADATA_LIMITS.depth)
    throw new SessionMetadataError(
      `The value of ${key} nests deeper than ${SESSION_METADATA_LIMITS.depth} levels.`,
    );
  if (Array.isArray(value)) {
    for (const entry of value) checkValue(key, entry, depth + 1);
    return;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    throw new SessionMetadataError(`The value of ${key} is not JSON.`);
  for (const entry of Object.values(value)) checkValue(key, entry, depth + 1);
}

function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

/** The same JSON, whatever order an object's keys come in. */
function sameJson(left: JsonValue, right: JsonValue): boolean {
  if (left === right) return true;
  if (
    typeof left !== "object" ||
    typeof right !== "object" ||
    left === null ||
    right === null
  )
    return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    return (
      left.length === right.length &&
      left.every((entry, index) => sameJson(entry, right[index] as JsonValue))
    );
  }
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every(
    (key) =>
      Object.hasOwn(right, key) &&
      sameJson(left[key] as JsonValue, right[key] as JsonValue),
  );
}
