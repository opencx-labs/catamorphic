/**
 * Wire types for the usage page (ADR 0057): the main-process transcript
 * scanner produces these, the renderer rolls them up. Data crossing the
 * bridge is buckets, never raw transcript records.
 */

export type UsageProvider = "claude" | "codex";

export interface UsageTokens {
  /** Uncached input tokens; never includes the cached portion. */
  inputTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  /** Subset of outputTokens; informational, never added to totals. */
  reasoningTokens: number;
}

export function totalTokens(tokens: UsageTokens): number {
  // reasoningTokens is inside outputTokens: adding it would double count.
  return (
    tokens.inputTokens +
    tokens.cachedInputTokens +
    tokens.cacheCreationTokens +
    tokens.outputTokens
  );
}

export interface UsageBucket {
  /** Local calendar day, YYYY-MM-DD. */
  day: string;
  /** ISO instant of the bucket start; hour resolution only. */
  hourStart?: string;
  provider: UsageProvider;
  model: string;
  tokens: UsageTokens;
  records: number;
  /** Records whose model has no known rate; their cost contributes 0. */
  unpricedRecords: number;
  costUsd: number;
  cacheSavingsUsd: number;
}

export type UsageWindowDays = 1 | 7 | 30 | 90;

export interface UsageSummary {
  buckets: UsageBucket[];
  /** Distinct sessions whose records actually landed in the window. */
  sessions: number;
  resolution: "day" | "hour";
  windowStartMs: number;
  windowEndMs: number;
  pricing: { status: "fresh" | "cached" | "none"; fetchedAtMs?: number };
  scannedFiles: number;
  duplicatesDropped: number;
  scanDurationMs: number;
}
