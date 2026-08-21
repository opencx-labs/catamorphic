/**
 * Wire types for the usage page (ADR 0057): the main-process transcript
 * scanner produces these, the renderer rolls them up. Data crossing the
 * bridge is buckets, never raw transcript records.
 */

export type UsageProvider = "claude" | "codex";

/** en-CA's default date rendering is exactly ISO-ordered YYYY-MM-DD. */
const localDayFormatter = new Intl.DateTimeFormat("en-CA", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/**
 * Local calendar day key (YYYY-MM-DD) for a timestamp. UsageBucket.day is
 * produced with this in main and consumed by the renderer's chart period
 * enumeration; both sides must agree on the exact shape or buckets miss
 * their bars.
 */
export function localDayKey(timestampMs: number): string {
  return localDayFormatter.format(new Date(timestampMs));
}

/** 3 significant figures with K/M/B/T so tabular columns line up. */
export function formatTokenCount(value: number): string {
  if (value < 1000) return String(value);
  const units = [
    { at: 1e12, suffix: "T" },
    { at: 1e9, suffix: "B" },
    { at: 1e6, suffix: "M" },
    { at: 1e3, suffix: "K" },
  ];
  for (const unit of units) {
    if (value >= unit.at) {
      return `${Number((value / unit.at).toPrecision(3))}${unit.suffix}`;
    }
  }
  return String(value);
}

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
