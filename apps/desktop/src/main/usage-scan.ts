/**
 * The usage scanner (ADR 0057): walks every transcript root this machine
 * has — the machine defaults `~/.claude` / `~/.codex` (local- and
 * api-key-auth agents, plus the user's own terminal sessions) and each
 * account-auth agent's isolated home under agent-homes/ — parses usage
 * records, prices them, and aggregates buckets for the usage page.
 *
 * Deliberately whole-machine: the page answers "what did I spend", not
 * "what did this app spend", and says so.
 *
 * Perf model mirrors what t3/ccusage learned the hard way: an mtime
 * prefilter with slack, a substring prefilter before JSON.parse, and a
 * per-file parsed-record cache keyed on (size, mtime, provider) persisted
 * as one JSON blob. Transcripts are append-only, so an unchanged file can
 * never yield different usage.
 */

import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import type {
  UsageBucket,
  UsageSummary,
  UsageWindowDays,
} from "../shared/usage.js";
import {
  cacheSavingsUsd,
  parseRateTable,
  priceTokens,
  type RateTable,
} from "./usage-pricing.js";
import {
  createCodexScanState,
  dedupeWithinFile,
  mightCarryUsage,
  parseClaudeLine,
  parseCodexLine,
  totalTokens,
  type UsageProvider,
  type UsageRecord,
  type UsageTokens,
} from "./usage-transcripts.js";

export type { UsageBucket, UsageSummary, UsageWindowDays };

interface CachedFile {
  size: number;
  mtimeMs: number;
  provider: UsageProvider;
  records: UsageRecord[];
}

/** Bump whenever parser semantics change: cached entries would otherwise
 *  keep serving records parsed under the old rules forever. */
const SCAN_CACHE_VERSION = 1;
/** The longest window the UI offers. */
const CACHE_RETENTION_DAYS = 90;
/** A session's last write can land well before local midnight on the
 *  window's first day; mtime admission needs slack. Out-of-window records
 *  in admitted files are filtered at aggregation. */
const MTIME_SLACK_MS = 36 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

const LITELLM_RATES_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
/** Rates move rarely; a day-old table keeps the page working offline. */
const RATES_TTL_MS = 24 * 60 * 60 * 1000;
const RATES_FETCH_TIMEOUT_MS = 10_000;

/** ISO-ordered local YYYY-MM-DD (en-CA renders exactly that shape). */
const dayFormatter = new Intl.DateTimeFormat("en-CA", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export interface UsageScannerDeps {
  /** The user's home directory (machine-default provider homes live here). */
  homeDir: string;
  /** agent-homes/ root; each subdir is one account-auth agent's home. */
  agentHomesDir: string;
  /** Directory for the scan cache and the cached rate table. */
  cacheDir: string;
}

export interface UsageScanner {
  summary(days: UsageWindowDays): Promise<UsageSummary>;
}

export function createUsageScanner(deps: UsageScannerDeps): UsageScanner {
  let fileCache: Map<string, CachedFile> | undefined;
  let cacheDirty = false;
  let rates:
    | { table: RateTable; fetchedAtMs: number; status: "fresh" | "cached" }
    | undefined;
  // Concurrent calls coalesce: a second request while a scan runs awaits
  // the same promise instead of racing the cache.
  let inFlight: Promise<UsageSummary> | undefined;
  let inFlightDays: UsageWindowDays | undefined;

  const cachePath = path.join(deps.cacheDir, "usage-scan-cache.json");
  const ratesPath = path.join(deps.cacheDir, "usage-model-rates.json");

  async function loadCache(): Promise<Map<string, CachedFile>> {
    if (fileCache) return fileCache;
    fileCache = new Map();
    try {
      const raw = JSON.parse(await fs.readFile(cachePath, "utf8")) as {
        version?: number;
        files?: Record<string, CachedFile>;
      };
      if (raw.version === SCAN_CACHE_VERSION && raw.files) {
        for (const [filePath, entry] of Object.entries(raw.files)) {
          if (
            typeof entry?.size === "number" &&
            typeof entry.mtimeMs === "number" &&
            Array.isArray(entry.records)
          ) {
            fileCache.set(filePath, entry);
          }
        }
      }
    } catch {
      // Missing or corrupt cache is a slower first scan, never an error.
    }
    return fileCache;
  }

  async function persistCache(): Promise<void> {
    if (!cacheDirty || !fileCache) return;
    try {
      await fs.mkdir(deps.cacheDir, { recursive: true });
      await fs.writeFile(
        cachePath,
        JSON.stringify({
          version: SCAN_CACHE_VERSION,
          files: Object.fromEntries(fileCache),
        }),
      );
      // Only after the write lands: a failed persist retries next scan.
      cacheDirty = false;
    } catch {
      // A slower next start, not a failed read.
    }
  }

  async function ensureRates(): Promise<void> {
    const now = Date.now();
    if (rates && now - rates.fetchedAtMs < RATES_TTL_MS) return;
    if (!rates) {
      try {
        const raw = JSON.parse(await fs.readFile(ratesPath, "utf8")) as {
          fetchedAtMs?: number;
          document?: unknown;
        };
        const table = parseRateTable(raw.document);
        if (typeof raw.fetchedAtMs === "number" && table.size > 0) {
          rates = { table, fetchedAtMs: raw.fetchedAtMs, status: "cached" };
          if (now - raw.fetchedAtMs < RATES_TTL_MS) return;
        }
      } catch {
        // No cached table; fall through to the fetch.
      }
    }
    try {
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), RATES_FETCH_TIMEOUT_MS);
      const response = await fetch(LITELLM_RATES_URL, { signal: abort.signal });
      clearTimeout(timer);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const document: unknown = await response.json();
      const table = parseRateTable(document);
      if (table.size === 0) throw new Error("empty rate table");
      rates = { table, fetchedAtMs: now, status: "fresh" };
      await fs.mkdir(deps.cacheDir, { recursive: true });
      await fs
        .writeFile(ratesPath, JSON.stringify({ fetchedAtMs: now, document }))
        .catch(() => {});
    } catch {
      // Keep serving the old table, but never keep claiming "fresh".
      if (rates) rates = { ...rates, status: "cached" };
    }
  }

  async function resolveRoots(): Promise<
    { provider: UsageProvider; dir: string }[]
  > {
    const candidates: { provider: UsageProvider; dir: string }[] = [
      {
        provider: "claude",
        dir: path.join(deps.homeDir, ".claude", "projects"),
      },
      { provider: "codex", dir: path.join(deps.homeDir, ".codex", "sessions") },
    ];
    // Account-auth agents run with CLAUDE_CONFIG_DIR / CODEX_HOME pointed
    // at agent-homes/<id>; the harness is legible from which transcript
    // subdir the CLI created there.
    try {
      const entries = await fs.readdir(deps.agentHomesDir, {
        withFileTypes: true,
      });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const home = path.join(deps.agentHomesDir, entry.name);
        candidates.push({
          provider: "claude",
          dir: path.join(home, "projects"),
        });
        candidates.push({
          provider: "codex",
          dir: path.join(home, "sessions"),
        });
      }
    } catch {
      // No agent homes yet.
    }
    const roots: { provider: UsageProvider; dir: string }[] = [];
    const seen = new Set<string>();
    for (const candidate of candidates) {
      let real: string;
      try {
        real = await fs.realpath(candidate.dir);
      } catch {
        continue; // root does not exist
      }
      // Two roots resolving to one directory must be counted once.
      if (seen.has(real)) continue;
      seen.add(real);
      roots.push({ provider: candidate.provider, dir: real });
    }
    return roots;
  }

  async function walkJsonl(dir: string): Promise<string[]> {
    const files: string[] = [];
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return files; // rotated away mid-walk
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await walkJsonl(full)));
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(full);
      }
    }
    return files;
  }

  /** Parse one file streaming; null means read failure, distinct from
   *  empty — a failure must never be cached as "no usage". */
  async function readFileRecords(
    filePath: string,
    provider: UsageProvider,
  ): Promise<UsageRecord[] | null> {
    try {
      const records: UsageRecord[] = [];
      const state = createCodexScanState();
      const lines = readline.createInterface({
        input: createReadStream(filePath, { encoding: "utf8" }),
        crlfDelay: Infinity,
      });
      for await (const line of lines) {
        if (!mightCarryUsage(line, provider)) continue;
        const record =
          provider === "claude"
            ? parseClaudeLine(line)
            : parseCodexLine(line, state);
        if (record) records.push(record);
      }
      return provider === "claude" ? dedupeWithinFile(records) : records;
    } catch {
      return null;
    }
  }

  async function fileRecords(
    filePath: string,
    provider: UsageProvider,
    size: number,
    mtimeMs: number,
  ): Promise<UsageRecord[]> {
    const cache = await loadCache();
    const cached = cache.get(filePath);
    // Provider is part of the identity: a hit parsed by the other parser
    // must never be reused.
    if (
      cached &&
      cached.size === size &&
      cached.mtimeMs === mtimeMs &&
      cached.provider === provider
    ) {
      return cached.records;
    }
    const parsed = await readFileRecords(filePath, provider);
    if (parsed === null) return [];
    cache.set(filePath, { size, mtimeMs, provider, records: parsed });
    cacheDirty = true;
    return parsed;
  }

  function pruneCache(
    walkedRoots: string[],
    livePaths: Set<string>,
    windowStartMs: number,
  ): void {
    if (!fileCache) return;
    const retentionCutoffMs =
      Date.now() - CACHE_RETENTION_DAYS * 24 * HOUR_MS - MTIME_SLACK_MS;
    for (const [filePath, entry] of fileCache) {
      const agedOut = entry.mtimeMs < retentionCutoffMs;
      // Absence from livePaths only proves deletion INSIDE the walked
      // window, and only under a root that was actually walked — a 7-day
      // look must not evict the 30-day warm entries, and a root that
      // failed to resolve must not lose its cache.
      const underWalkedRoot = walkedRoots.some((root) =>
        filePath.startsWith(root + path.sep),
      );
      const deleted =
        underWalkedRoot &&
        entry.mtimeMs >= windowStartMs &&
        !livePaths.has(filePath);
      if (agedOut || deleted) {
        fileCache.delete(filePath);
        cacheDirty = true;
      }
    }
  }

  async function runScan(days: UsageWindowDays): Promise<UsageSummary> {
    const startedAt = Date.now();
    const resolution: "day" | "hour" = days === 1 ? "hour" : "day";
    const windowEndMs = startedAt;
    let windowStartMs: number;
    if (resolution === "hour") {
      // Aligned to the minute so hour buckets are stable fixed-duration
      // offsets from the window start (DST-proof, unlike wall-clock hours).
      windowStartMs =
        Math.floor((windowEndMs - 24 * HOUR_MS) / 60_000) * 60_000;
    } else {
      // Local midnight of (today - (days - 1)): calendar arithmetic, not
      // fixed milliseconds, so the window survives DST transitions.
      const start = new Date(windowEndMs);
      start.setHours(0, 0, 0, 0);
      start.setDate(start.getDate() - (days - 1));
      windowStartMs = start.getTime();
    }
    const sinceDay = dayFormatter.format(new Date(windowStartMs));
    const untilDay = dayFormatter.format(new Date(windowEndMs));

    await ensureRates();
    const table: RateTable = rates?.table ?? new Map();
    const roots = await resolveRoots();

    const admissionCutoffMs = windowStartMs - MTIME_SLACK_MS;
    const buckets = new Map<string, UsageBucket>();
    const seenKeys = new Set<string>();
    const landedSessions = new Set<string>();
    let scannedFiles = 0;
    let duplicatesDropped = 0;
    const livePaths = new Set<string>();

    for (const root of roots) {
      for (const filePath of await walkJsonl(root.dir)) {
        livePaths.add(filePath);
        let size: number;
        let mtimeMs: number;
        try {
          const stats = await fs.stat(filePath);
          size = stats.size;
          mtimeMs = stats.mtimeMs;
        } catch {
          continue; // vanished between readdir and stat
        }
        if (mtimeMs < admissionCutoffMs) continue;
        scannedFiles += 1;
        for (const record of await fileRecords(
          filePath,
          root.provider,
          size,
          mtimeMs,
        )) {
          if (
            record.timestampMs < windowStartMs ||
            record.timestampMs >= windowEndMs
          ) {
            continue;
          }
          const day = dayFormatter.format(new Date(record.timestampMs));
          if (resolution === "day" && (day < sinceDay || day > untilDay)) {
            continue;
          }
          // Global dedupe: resumed/forked Claude sessions copy records
          // across transcripts; first record wins.
          if (record.dedupeKey !== null) {
            const key = `${root.provider} ${record.dedupeKey}`;
            if (seenKeys.has(key)) {
              duplicatesDropped += 1;
              continue;
            }
            seenKeys.add(key);
          }
          if (record.sessionId) {
            landedSessions.add(`${root.provider} ${record.sessionId}`);
          }
          const hourStart =
            resolution === "hour"
              ? new Date(
                  windowStartMs +
                    Math.floor((record.timestampMs - windowStartMs) / HOUR_MS) *
                      HOUR_MS,
                ).toISOString()
              : undefined;
          const bucketKey = `${day} ${hourStart ?? ""} ${root.provider} ${record.model}`;
          let bucket = buckets.get(bucketKey);
          if (!bucket) {
            bucket = {
              day,
              ...(hourStart ? { hourStart } : {}),
              provider: root.provider,
              model: record.model,
              tokens: {
                inputTokens: 0,
                cachedInputTokens: 0,
                cacheCreationTokens: 0,
                outputTokens: 0,
                reasoningTokens: 0,
              },
              records: 0,
              unpricedRecords: 0,
              costUsd: 0,
              cacheSavingsUsd: 0,
            };
            buckets.set(bucketKey, bucket);
          }
          bucket.tokens.inputTokens += record.tokens.inputTokens;
          bucket.tokens.cachedInputTokens += record.tokens.cachedInputTokens;
          bucket.tokens.cacheCreationTokens +=
            record.tokens.cacheCreationTokens;
          bucket.tokens.outputTokens += record.tokens.outputTokens;
          bucket.tokens.reasoningTokens += record.tokens.reasoningTokens;
          bucket.records += 1;
          const cost = priceTokens(table, record.model, record.tokens);
          if (cost === null) {
            bucket.unpricedRecords += 1;
          } else {
            bucket.costUsd += cost;
            bucket.cacheSavingsUsd += cacheSavingsUsd(
              table,
              record.model,
              record.tokens,
            );
          }
        }
      }
    }

    pruneCache(
      roots.map((root) => root.dir),
      livePaths,
      admissionCutoffMs,
    );
    await persistCache();

    const sorted = [...buckets.values()].sort((a, b) =>
      `${a.day} ${a.hourStart ?? ""} ${a.provider} ${a.model}`.localeCompare(
        `${b.day} ${b.hourStart ?? ""} ${b.provider} ${b.model}`,
      ),
    );
    return {
      buckets: sorted,
      sessions: landedSessions.size,
      resolution,
      windowStartMs,
      windowEndMs,
      pricing: rates
        ? { status: rates.status, fetchedAtMs: rates.fetchedAtMs }
        : { status: "none" },
      scannedFiles,
      duplicatesDropped,
      scanDurationMs: Date.now() - startedAt,
    };
  }

  return {
    summary(days) {
      if (inFlight && inFlightDays === days) return inFlight;
      const scan = runScan(days).finally(() => {
        if (inFlight === scan) {
          inFlight = undefined;
          inFlightDays = undefined;
        }
      });
      inFlight = scan;
      inFlightDays = days;
      return scan;
    },
  };
}

export { totalTokens };
