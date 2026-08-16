import type {
  AgentChatTextAttachment,
  AgentChatTextSource,
} from "@catamorphic/react";

/**
 * Classifying pasted/dropped text into composer pills. Ordinary short text
 * pastes natively into the composer — pills are for things that would
 * otherwise drown the message: big blocks, URLs, and file paths.
 */

/** Pastes at or beyond either bound become a pill instead of raw text. */
export const BIG_PASTE_CHARS = 1500;
export const BIG_PASTE_LINES = 10;

const URL_PATTERN = /^(https?:\/\/|file:\/\/)\S+$/i;
// Absolute POSIX/Windows paths, ~-relative, or a bare relative path with a
// file extension. Single token, no spaces (paths with spaces would need
// quoting; too ambiguous to sniff from a paste).
const PATH_PATTERN =
  /^(?:\/|~\/|[A-Za-z]:\\)[^\s]+$|^(?:\.{1,2}\/)?[\w@.-]+(?:\/[\w@.-]+)+\.[A-Za-z0-9]{1,8}$/;

export type PillClassification =
  | { kind: "native" }
  | { kind: "pill"; source: AgentChatTextSource; name: string };

/** Decide what a pasted string becomes. */
export function classifyPastedText(raw: string): PillClassification {
  const text = raw.replace(/\r\n?/g, "\n");
  const trimmed = text.trim();
  if (!trimmed) return { kind: "native" };
  const singleLine = !trimmed.includes("\n");
  if (singleLine && URL_PATTERN.test(trimmed)) {
    return {
      kind: "pill",
      source: { type: "url", url: trimmed },
      name: trimmed,
    };
  }
  if (singleLine && PATH_PATTERN.test(trimmed)) {
    return {
      kind: "pill",
      source: { type: "path", path: trimmed },
      name: trimmed.split(/[\\/]/).at(-1) || trimmed,
    };
  }
  const lines = text.split("\n").length;
  if (text.length >= BIG_PASTE_CHARS || lines >= BIG_PASTE_LINES) {
    return { kind: "pill", source: { type: "paste" }, name: pasteName(text) };
  }
  return { kind: "native" };
}

/** Pill label for a paste: its first non-empty line, clipped. */
export function pasteName(text: string): string {
  const first = text.split("\n").find((line) => line.trim().length > 0) ?? "";
  const clipped = first.trim().replace(/\s+/g, " ");
  return clipped.length > 48
    ? `${clipped.slice(0, 47)}…`
    : clipped || "Pasted text";
}

/** Pill label for an editor selection: `file.md · 12–24`. */
export function selectionName(opts: {
  filePath: string;
  startLine?: number;
  endLine?: number;
}): string {
  const base = opts.filePath.split("/").at(-1) || opts.filePath;
  if (opts.startLine === undefined) return base;
  const range =
    opts.endLine !== undefined && opts.endLine !== opts.startLine
      ? `${opts.startLine}–${opts.endLine}`
      : `${opts.startLine}`;
  return `${base} · ${range}`;
}

export function textPill(
  text: string,
  source: AgentChatTextSource,
  name: string,
): AgentChatTextAttachment {
  return { kind: "text", name, text, source };
}

/** Compact stats for the pill's collapsed state ("2.1k chars · 34 lines"). */
export function textStats(text: string): string {
  const chars = text.length;
  const lines = text.split("\n").length;
  const charLabel =
    chars >= 1000
      ? `${(chars / 1000).toFixed(chars >= 10_000 ? 0 : 1)}k chars`
      : `${chars} chars`;
  return lines > 1 ? `${charLabel} · ${lines} lines` : charLabel;
}
