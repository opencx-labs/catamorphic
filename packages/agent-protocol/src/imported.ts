import type { ItemPayload, ItemStatus } from "./model.js";

/**
 * Sessions another tool ran, read from its own transcript store (ADR
 * 0233): Claude Code's `~/.claude/projects` and Codex's `~/.codex/sessions`.
 */
export const IMPORTED_HARNESSES = ["claude-code", "codex"] as const;

export type ImportedHarness = (typeof IMPORTED_HARNESSES)[number];

export function isImportedHarness(value: unknown): value is ImportedHarness {
  return (IMPORTED_HARNESSES as readonly unknown[]).includes(value);
}

/** Where an imported session came from: a session's `imported` field. */
export interface ImportedSession {
  harness: ImportedHarness;
  /** The tool's own session id (Claude Code session, Codex thread). */
  nativeSessionId: string;
  /** The transcript file read last. */
  sourcePath: string;
  /** SHA-256 of the content read last: an unchanged file writes nothing. */
  contentSha256: string;
  sourceModifiedAt: string;
}

/** The kinds of item a transcript reader produces. */
export type ImportedItemPayload = ItemPayload<
  | "assistant_message"
  | "reasoning"
  | "tool_call"
  | "command"
  | "file_change"
  | "plan"
  | "subagent"
>;

export interface ImportedItem {
  /** The tool's own id for the item: stable across reads, unique in the transcript. */
  key: string;
  /** The item this one ran under (a native subagent's work). */
  parentKey?: string;
  /** `in_progress` while the tool has not finished it. */
  status: ItemStatus;
  at: string;
  item: ImportedItemPayload;
}

export interface ImportedTurn {
  /** The tool's own id for the turn: stable across reads. */
  key: string;
  /** What the person wrote; null for a turn the tool started itself. */
  input: { key: string; text: string; at: string } | null;
  /** A turn the tool has not finished yet reads as completed until it does. */
  status: "completed" | "failed" | "interrupted";
  error: string | null;
  startedAt: string;
  completedAt: string | null;
  items: ImportedItem[];
}

/**
 * A transcript as a reader understood it, independent of the tool that
 * wrote it. Core writes it into a session's log (ADR 0233).
 */
export interface ImportedTranscript {
  harness: ImportedHarness;
  nativeSessionId: string;
  /** The working directory the session ran in. */
  cwd: string;
  /** The tool's own title for the session, when it wrote one. */
  title: string | null;
  model: string | null;
  startedAt: string;
  turns: ImportedTurn[];
}

/** A title from a session's first words: one line, at most 80 characters. */
export function importedTitle(text: string): string | null {
  const line = text
    .split("\n")
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  if (!line) return null;
  return line.length > 80 ? `${line.slice(0, 79).trimEnd()}…` : line;
}
