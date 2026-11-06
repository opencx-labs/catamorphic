import { readFile } from "node:fs/promises";
import type { JsonObject } from "@catamorphic/agent-protocol";

/**
 * A recorded conversation between the Codex adapter and the pinned
 * `codex app-server` (ADR 0198: tests replay real transcripts). Entries are
 * in the order they crossed the process boundary, so a replay keeps every
 * race between responses, notifications and server requests as it was.
 *
 * Machine-specific strings (the scenario's temporary root, the loopback
 * model URL, the Node binary, this package's fixtures) are stored as
 * `{{name}}` placeholders and substituted when a replay loads it.
 */
export interface CodexTranscript {
  provider: "codex";
  /** Bumped when entries change shape. */
  format: 1;
  /** The pinned CLI the transcript was recorded from. */
  cliVersion: string;
  /** The app-server protocol generation (`codex app-server generate-ts --experimental`). */
  protocolVersion: string;
  scenario: string;
  description: string;
  entries: CodexTranscriptEntry[];
}

export type CodexTranscriptEntry =
  /** The adapter started a process; replay checks its arguments and environment. */
  | { spawn: { args: string[]; env: Record<string, string> } }
  /** A JSON-RPC frame the adapter must send next. */
  | { expect_outbound: JsonObject }
  /** A frame the app server sent, `afterMs` after the previous entry. */
  | { emit_inbound: JsonObject; afterMs?: number }
  /** Bytes the app server appended to a file it owns (a rollout) by this point. */
  | { file_append: { path: string; text: string } }
  /** The adapter closed the process's input. */
  | { client_close: true }
  /** The process ended. */
  | { runtime_exit: { code: number | null; signal: string | null } };

/** Values substituted for `{{name}}` placeholders. */
export type TranscriptPlaceholders = Record<string, string>;

/** Replace every `{{name}}` in the transcript's strings. */
export function materializeTranscript(
  transcript: CodexTranscript,
  placeholders: TranscriptPlaceholders,
): CodexTranscript {
  return mapStrings(transcript, (text) =>
    text.replace(
      /\{\{(\w+)\}\}/g,
      (match, name: string) => placeholders[name] ?? match,
    ),
  );
}

/** Store real strings as placeholders: the longest value first. */
export function abstractTranscript(
  transcript: CodexTranscript,
  placeholders: TranscriptPlaceholders,
): CodexTranscript {
  const pairs = Object.entries(placeholders)
    .filter(([, value]) => value)
    .sort(([, a], [, b]) => b.length - a.length);
  return mapStrings(transcript, (text) =>
    pairs.reduce(
      (current, [name, real]) => current.split(real).join(`{{${name}}}`),
      text,
    ),
  );
}

/** A deep copy of a JSON value with every string value rewritten. */
function mapStrings<T>(value: T, rewrite: (text: string) => string): T {
  const walk = (inner: unknown): unknown => {
    if (typeof inner === "string") return rewrite(inner);
    if (Array.isArray(inner)) return inner.map(walk);
    if (inner && typeof inner === "object")
      return Object.fromEntries(
        Object.entries(inner).map(([key, child]) => [key, walk(child)]),
      );
    return inner;
  };
  return walk(value) as T;
}

export async function readTranscript(file: string): Promise<CodexTranscript> {
  const value: unknown = JSON.parse(await readFile(file, "utf8"));
  if (
    typeof value !== "object" ||
    value === null ||
    (value as { provider?: unknown }).provider !== "codex" ||
    !Array.isArray((value as { entries?: unknown }).entries)
  )
    throw new Error(`${file} is not a Codex transcript`);
  return value as CodexTranscript;
}
