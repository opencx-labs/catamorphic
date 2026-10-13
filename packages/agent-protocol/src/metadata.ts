import { z } from "zod";
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
 * or value, or a write that grows the object beyond
 * {@link SESSION_METADATA_LIMITS} (one that shrinks it always goes through).
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
    checkKey(key);
    if (value === null) {
      if (Object.hasOwn(next, key)) {
        delete next[key];
        changed = true;
      }
      continue;
    }
    checkEntry(key, value);
    const before = Object.hasOwn(next, key) ? next[key] : undefined;
    if (before !== undefined && sameJson(before, value)) continue;
    next[key] = value;
    changed = true;
  }
  if (!changed) return current;
  const keys = Object.keys(next).length;
  if (keys > SESSION_METADATA_LIMITS.keys && keys > Object.keys(current).length)
    throw new SessionMetadataError(
      `A session holds at most ${SESSION_METADATA_LIMITS.keys} metadata keys; remove one first.`,
    );
  const bytes = jsonBytes(next);
  if (bytes > SESSION_METADATA_LIMITS.totalBytes && bytes > jsonBytes(current))
    throw new SessionMetadataError(
      `A session's metadata is at most ${SESSION_METADATA_LIMITS.totalBytes} bytes as JSON; remove or shorten a value first.`,
    );
  return next;
}

/**
 * Throws {@link SessionMetadataError} unless `metadata` keeps every rule a
 * write keeps: what one copy of a session takes from another (a mirror's
 * base and its events) is held to the same limits.
 */
export function assertSessionMetadata(
  metadata: unknown,
): asserts metadata is SessionMetadata {
  if (
    typeof metadata !== "object" ||
    metadata === null ||
    Array.isArray(metadata) ||
    (Object.getPrototypeOf(metadata) !== Object.prototype &&
      Object.getPrototypeOf(metadata) !== null)
  )
    throw new SessionMetadataError("Session metadata is an object of values.");
  const entries = Object.entries(metadata);
  for (const [key, value] of entries) {
    checkKey(key);
    if (value === null)
      throw new SessionMetadataError(`The value of ${key} is null.`);
    checkEntry(key, value);
  }
  if (entries.length > SESSION_METADATA_LIMITS.keys)
    throw new SessionMetadataError(
      `A session holds at most ${SESSION_METADATA_LIMITS.keys} metadata keys.`,
    );
  if (jsonBytes(metadata) > SESSION_METADATA_LIMITS.totalBytes)
    throw new SessionMetadataError(
      `A session's metadata is at most ${SESSION_METADATA_LIMITS.totalBytes} bytes as JSON.`,
    );
}

function checkKey(key: string): void {
  if (
    key.length > SESSION_METADATA_LIMITS.keyLength ||
    !SESSION_METADATA_KEY_PATTERN.test(key)
  )
    throw new SessionMetadataError(
      `"${key.slice(0, 80)}" is not a metadata key: use lowercase words of letters and digits joined by _, - or ., at most ${SESSION_METADATA_LIMITS.keyLength} characters, starting with a letter.`,
    );
}

/** One value: plain bounded JSON, within its size. */
function checkEntry(key: string, value: unknown): void {
  checkValue(key, value, 0);
  if (jsonBytes(value) > SESSION_METADATA_LIMITS.valueBytes)
    throw new SessionMetadataError(
      `The value of ${key} is larger than ${SESSION_METADATA_LIMITS.valueBytes} bytes as JSON.`,
    );
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

// ---------------------------------------------------------------------------
// The pull requests a chat keeps (ADR 0225)

/** The states a recorded pull request can say it is in. */
export type SessionPullRequestState = "open" | "draft" | "merged" | "closed";

/** One entry of {@link SESSION_PULL_REQUESTS_KEY}. */
export interface SessionPullRequest {
  url: string;
  number?: number;
  title?: string;
  state?: SessionPullRequestState;
}

/** The metadata key a chat's pull requests are kept under. */
export const SESSION_PULL_REQUESTS_KEY = "pull_requests";

/**
 * The convention in one sentence, quoted by every tool and skill that
 * teaches it, so agents meet one shape wherever they read about it.
 */
export const SESSION_PULL_REQUESTS_CONTRACT =
  "pull_requests lists the pull requests a chat opened or works on, as an array of { url, number?, title?, state? } with state open, draft, merged or closed.";

/**
 * `set_session_metadata`, the one tool every host offers agents for their
 * own chat's metadata: its description and input, so each projection
 * (Work's workspace tools, the project MCP) says the same thing.
 */
export const SET_SESSION_METADATA_DESCRIPTION = `Set one named value on this chat's session, replacing what the key held, or remove the key with null; omit value to read the session's metadata. Work shows these values beside the chat. ${SESSION_PULL_REQUESTS_CONTRACT} Read a list before writing it again and keep what it holds. Returns the session's metadata.`;

export const setSessionMetadataInputSchema = z.object({
  key: z
    .string()
    .max(SESSION_METADATA_LIMITS.keyLength)
    .regex(SESSION_METADATA_KEY_PATTERN)
    .describe("Lowercase words joined by _, - or ., e.g. pull_requests"),
  value: z
    .json()
    .optional()
    .describe("Any JSON; null removes the key, omitted reads"),
});

const PULL_REQUEST_STATES: readonly SessionPullRequestState[] = [
  "open",
  "draft",
  "merged",
  "closed",
];

/**
 * The pull requests recorded in a session's metadata, read leniently:
 * agents write metadata, so entries without a web address, repeated
 * addresses and fields of other shapes are left out.
 */
export function sessionPullRequests(metadata: unknown): SessionPullRequest[] {
  const value =
    typeof metadata === "object" && metadata !== null
      ? Object.entries(metadata).find(
          ([key]) => key === SESSION_PULL_REQUESTS_KEY,
        )?.[1]
      : undefined;
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((entry): SessionPullRequest[] => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry))
      return [];
    const record = Object.fromEntries(Object.entries(entry));
    const url = typeof record.url === "string" ? record.url.trim() : "";
    if (!/^https?:\/\//i.test(url) || seen.has(url)) return [];
    seen.add(url);
    const number =
      typeof record.number === "number" &&
      Number.isInteger(record.number) &&
      record.number > 0
        ? record.number
        : undefined;
    const title =
      typeof record.title === "string" && record.title.trim()
        ? record.title.trim()
        : undefined;
    const state = PULL_REQUEST_STATES.find(
      (candidate) => candidate === record.state,
    );
    return [
      {
        url,
        ...(number !== undefined ? { number } : {}),
        ...(title ? { title } : {}),
        ...(state ? { state } : {}),
      },
    ];
  });
}
