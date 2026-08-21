/**
 * Pure line parsers for the provider CLIs' local session transcripts
 * (ADR 0057). The scanner in usage-scan.ts streams JSONL lines through
 * these; everything here is synchronous, filesystem-free, and unit-tested.
 *
 * Two formats:
 * - Claude Code: `<home>/projects/<cwd-slug>/<sessionUuid>.jsonl`, one
 *   record per assistant CONTENT BLOCK, each repeating the parent
 *   message's whole `usage` object. Records dedupe on message id +
 *   request id or totals run ~2.4x high.
 * - Codex: `<home>/sessions/<y>/<m>/<d>/rollout-*.jsonl`, `token_count`
 *   events carrying per-turn deltas. Forked/subagent rollouts replay the
 *   parent's history re-stamped to the fork instant; that burst must be
 *   suppressed or totals run ~1.85x high.
 */

import {
  totalTokens,
  type UsageProvider,
  type UsageTokens,
} from "../shared/usage.js";

export type { UsageProvider, UsageTokens };
export { totalTokens };

export interface UsageRecord {
  timestampMs: number;
  model: string;
  sessionId: string;
  tokens: UsageTokens;
  /**
   * Cross-file identity for Claude records (`messageId:requestId`);
   * resumed and forked sessions copy records forward between transcripts,
   * so dedupe must be global across the scan. Null when the format has no
   * stable id (Codex, which dedupes structurally instead).
   */
  dedupeKey: string | null;
}

/**
 * Cheap substring prefilter run before JSON.parse: most transcript lines
 * carry no usage, and skipping the parse is what keeps a cold multi-week
 * scan tolerable. Codex additionally needs `turn_context`/`session_meta`
 * lines through — they carry no usage but drive the reducer state.
 */
export function mightCarryUsage(
  line: string,
  provider: UsageProvider,
): boolean {
  if (provider === "claude") return line.includes('"usage"');
  return (
    line.includes('"token_count"') ||
    line.includes('"turn_context"') ||
    line.includes('"session_meta"')
  );
}

function positiveInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : 0;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

/** One Claude Code transcript line to a usage record, or null. */
export function parseClaudeLine(line: string): UsageRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null; // torn trailing line of a live file; next scan re-reads
  }
  const record = asRecord(parsed);
  if (!record || record.type !== "assistant") return null;
  const message = asRecord(record.message);
  const usage = asRecord(message?.usage);
  if (!message || !usage) return null;
  const model = typeof message.model === "string" ? message.model : "";
  if (model.length === 0) return null;
  const timestampMs = parseTimestamp(record.timestamp);
  if (timestampMs === undefined) return null;

  const messageId = typeof message.id === "string" ? message.id : null;
  const requestId =
    typeof record.requestId === "string" ? record.requestId : null;
  const details = asRecord(usage.output_tokens_details);
  const outputTokens = positiveInt(usage.output_tokens);
  return {
    timestampMs,
    model,
    sessionId: typeof record.sessionId === "string" ? record.sessionId : "",
    tokens: {
      inputTokens: positiveInt(usage.input_tokens),
      cachedInputTokens: positiveInt(usage.cache_read_input_tokens),
      cacheCreationTokens: positiveInt(usage.cache_creation_input_tokens),
      outputTokens,
      reasoningTokens: Math.min(
        outputTokens,
        positiveInt(details?.thinking_tokens),
      ),
    },
    // Records with neither id cannot be de-duplicated; keep them.
    dedupeKey:
      messageId === null && requestId === null
        ? null
        : `${messageId ?? ""}:${requestId ?? ""}`,
  };
}

/**
 * Rolling per-file state for the Codex reducer. `token_count` events carry
 * no model or session id of their own: the model comes from the last
 * `turn_context`, the session from the FIRST `session_meta` (forked
 * rollouts replay their ancestors' metas).
 */
export interface CodexScanState {
  model?: string;
  sessionId?: string;
  sawSessionMeta: boolean;
  /** JSON signature of the last counted delta; Codex re-emits unchanged
   *  token_count events on some stream boundaries. */
  lastUsageSignature?: string;
  /** True while skipping the fork-copy burst at the top of a forked file. */
  suppressingForkCopies: boolean;
  forkCopyAnchorMs: number;
}

export function createCodexScanState(): CodexScanState {
  return {
    sawSessionMeta: false,
    suppressingForkCopies: false,
    forkCopyAnchorMs: 0,
  };
}

/**
 * Copied parent history lands in one synchronous burst (observed gaps
 * 0-40ms); the fork's first real usage arrives seconds later. Events
 * within this gap of the rolling anchor are copies.
 */
const FORK_COPY_MAX_GAP_MS = 1000;

function isForkedSessionMeta(payload: Record<string, unknown>): boolean {
  if (typeof payload.forked_from_id === "string") return true;
  const source = asRecord(payload.source);
  const subagent = asRecord(source?.subagent);
  const spawn = asRecord(subagent?.thread_spawn);
  return typeof spawn?.parent_thread_id === "string";
}

/** One Codex rollout line through the reducer; returns a record when the
 *  line is a countable token_count delta. */
export function parseCodexLine(
  line: string,
  state: CodexScanState,
): UsageRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  const record = asRecord(parsed);
  const payload = asRecord(record?.payload);
  if (!record || !payload) return null;
  const timestampMs = parseTimestamp(record.timestamp);
  // Older rollouts repeat the line kind inside the payload; current ones
  // carry it only on the outer record. Accept either.
  const kind =
    typeof record.type === "string" ? record.type : String(payload.type ?? "");

  if (kind === "session_meta" || payload.type === "session_meta") {
    if (!state.sawSessionMeta) {
      state.sawSessionMeta = true;
      const id = payload.id ?? payload.session_id;
      if (typeof id === "string") state.sessionId = id;
    }
    if (isForkedSessionMeta(payload) && timestampMs !== undefined) {
      state.suppressingForkCopies = true;
      state.forkCopyAnchorMs = timestampMs;
    }
    return null;
  }
  if (kind === "turn_context" || payload.type === "turn_context") {
    if (typeof payload.model === "string" && payload.model.length > 0) {
      state.model = payload.model;
    }
    return null;
  }
  if (payload.type !== "token_count") return null;

  const info = asRecord(payload.info);
  const last = asRecord(info?.last_token_usage);
  if (!last || timestampMs === undefined) return null;
  // A token_count before any turn_context has nothing to attribute to.
  if (!state.model) return null;

  // Deltas reconcile with the session's final total ONLY with consecutive
  // duplicates dropped. The signature is consumed here, after the
  // attribution guard, so an unattributable early event cannot poison it.
  const signature = JSON.stringify(last);
  if (signature === state.lastUsageSignature) return null;

  if (state.suppressingForkCopies) {
    if (timestampMs - state.forkCopyAnchorMs < FORK_COPY_MAX_GAP_MS) {
      state.forkCopyAnchorMs = timestampMs;
      return null;
    }
    state.suppressingForkCopies = false;
  }
  state.lastUsageSignature = signature;

  const inputTokens = positiveInt(last.input_tokens);
  const cachedInputTokens = positiveInt(last.cached_input_tokens);
  const cacheCreationTokens = positiveInt(last.cache_write_input_tokens);
  const outputTokens = positiveInt(last.output_tokens);
  const tokens: UsageTokens = {
    // Codex reports input_tokens inclusive of the cached portion.
    inputTokens: Math.max(
      0,
      inputTokens - cachedInputTokens - cacheCreationTokens,
    ),
    cachedInputTokens,
    cacheCreationTokens,
    outputTokens,
    reasoningTokens: Math.min(
      outputTokens,
      positiveInt(last.reasoning_output_tokens),
    ),
  };
  if (totalTokens(tokens) === 0) return null;
  return {
    timestampMs,
    model: state.model,
    sessionId: state.sessionId ?? "",
    tokens,
    dedupeKey: null,
  };
}

/** Parse a whole file's lines (already split) into records. */
export function parseTranscriptLines(
  lines: Iterable<string>,
  provider: UsageProvider,
): UsageRecord[] {
  const records: UsageRecord[] = [];
  const state = createCodexScanState();
  for (const line of lines) {
    if (!mightCarryUsage(line, provider)) continue;
    const record =
      provider === "claude"
        ? parseClaudeLine(line)
        : parseCodexLine(line, state);
    if (record) records.push(record);
  }
  return provider === "claude" ? dedupeWithinFile(records) : records;
}

/**
 * Within-file dedupe (first record wins) before the file's records enter
 * the cache: it strips the per-content-block copies. The scan still runs
 * a global pass over the survivors, because resumed/forked sessions copy
 * records ACROSS files.
 */
export function dedupeWithinFile(records: UsageRecord[]): UsageRecord[] {
  const seen = new Set<string>();
  const result: UsageRecord[] = [];
  for (const record of records) {
    if (record.dedupeKey !== null) {
      if (seen.has(record.dedupeKey)) continue;
      seen.add(record.dedupeKey);
    }
    result.push(record);
  }
  return result;
}
