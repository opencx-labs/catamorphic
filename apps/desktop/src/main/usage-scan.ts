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

import {
  createReadStream,
  type Dirent,
  promises as fs,
  type Stats,
} from "node:fs";
import path from "node:path";
import {
  localDayKey,
  type UsageBucket,
  type UsageSummary,
  type UsageWindowDays,
} from "../shared/usage.js";
import {
  cacheSavingsUsd,
  parseRateTable,
  priceTokens,
  type RateTable,
} from "./usage-pricing.js";
import {
  type CodexScanState,
  createCodexScanState,
  dedupeWithinFile,
  mightCarryUsage,
  parseClaudeLine,
  parseCodexLine,
  type UsageProvider,
  type UsageRecord,
} from "./usage-transcripts.js";

interface CachedFile {
  size: number;
  mtimeMs: number;
  provider: UsageProvider;
  records: UsageRecord[];
  /** Byte offset just past the last COMPLETE parsed line; a grown file
   *  resumes parsing here instead of from byte 0. */
  parsedBytes: number;
  /** Codex reducer state as of parsedBytes; null for Claude entries. */
  codexState: CodexScanState | null;
}

/** Bump whenever parser semantics change: cached entries would otherwise
 *  keep serving records parsed under the old rules forever.
 *  v2 = incremental entries (shape change: parsedBytes + codexState). */
const SCAN_CACHE_VERSION = 2;
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
/** Offline first runs must not stall every page load on a doomed fetch;
 *  token counts render without prices. */
const RATES_RETRY_BACKOFF_MS = 5 * 60 * 1000;
/** A live transcript keeps every scan dirty; rewriting the whole cache
 *  blob each time is wasted IO, and an unpersisted increment only costs
 *  a re-parse after restart. */
const PERSIST_MIN_INTERVAL_MS = 60_000;
/** Files stat+parse through a small pool; aggregation stays sequential. */
const CONCURRENT_FILE_READS = 8;

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
  let lastPersistMs: number | undefined;
  let rates:
    | { table: RateTable; fetchedAtMs: number; status: "fresh" | "cached" }
    | undefined;
  let ratesFetchFailedAtMs: number | undefined;
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
            typeof entry.parsedBytes === "number" &&
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
    if (
      lastPersistMs !== undefined &&
      Date.now() - lastPersistMs < PERSIST_MIN_INTERVAL_MS
    ) {
      return;
    }
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
      lastPersistMs = Date.now();
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
    // A recent failure means offline or blocked; back off instead of
    // paying the fetch timeout on every summary().
    if (
      ratesFetchFailedAtMs !== undefined &&
      now - ratesFetchFailedAtMs < RATES_RETRY_BACKOFF_MS
    ) {
      return;
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
      ratesFetchFailedAtMs = undefined;
      await fs.mkdir(deps.cacheDir, { recursive: true });
      await fs
        .writeFile(ratesPath, JSON.stringify({ fetchedAtMs: now, document }))
        .catch(() => {});
    } catch {
      // Keep serving the old table, but never keep claiming "fresh".
      ratesFetchFailedAtMs = now;
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
    let entries: Dirent[];
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

  /** Parse lines from a byte offset onward, mutating `state` as the codex
   *  reducer consumes them; null means read failure, distinct from empty —
   *  a failure must never be cached as "no usage". Lines are split by hand
   *  because byte offsets must advance only past COMPLETE lines: a torn
   *  trailing line of a live file is left for the next scan to finish. */
  async function readFileRecords(
    filePath: string,
    provider: UsageProvider,
    start: number,
    state: CodexScanState,
  ): Promise<{ records: UsageRecord[]; parsedBytes: number } | null> {
    try {
      const records: UsageRecord[] = [];
      let parsedBytes = start;
      // The utf8 decode is chunk-boundary-safe (string_decoder buffers a
      // split multibyte sequence); `start` always lands on a line start,
      // which is a character boundary.
      const stream = createReadStream(filePath, { start, encoding: "utf8" });
      let carry = "";
      for await (const chunk of stream as AsyncIterable<string>) {
        carry += chunk;
        let newlineAt = carry.indexOf("\n");
        while (newlineAt !== -1) {
          const line = carry.slice(0, newlineAt);
          carry = carry.slice(newlineAt + 1);
          parsedBytes += Buffer.byteLength(line, "utf8") + 1;
          if (!mightCarryUsage(line, provider)) continue;
          const record =
            provider === "claude"
              ? parseClaudeLine(line)
              : parseCodexLine(line, state);
          if (record) records.push(record);
          newlineAt = carry.indexOf("\n");
        }
      }
      return { records, parsedBytes };
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
    // Transcripts are append-only: a grown file resumes from parsedBytes
    // with the persisted reducer state. Shrunk size or regressed mtime
    // means the file was replaced; re-parse from byte 0.
    if (
      cached &&
      cached.provider === provider &&
      size > cached.size &&
      mtimeMs >= cached.mtimeMs &&
      cached.parsedBytes <= cached.size
    ) {
      const state = cached.codexState
        ? { ...cached.codexState }
        : createCodexScanState();
      const tail = await readFileRecords(
        filePath,
        provider,
        cached.parsedBytes,
        state,
      );
      // Failed incremental read: serve the cached records untouched and
      // let the next scan retry.
      if (tail === null) return cached.records;
      const records = [...cached.records];
      if (provider === "claude") {
        // Within-file dedupe must stay exact across increments: appended
        // records check against the keys already kept in the cache.
        const seen = new Set<string>();
        for (const record of records) {
          if (record.dedupeKey !== null) seen.add(record.dedupeKey);
        }
        for (const record of tail.records) {
          if (record.dedupeKey !== null) {
            if (seen.has(record.dedupeKey)) continue;
            seen.add(record.dedupeKey);
          }
          records.push(record);
        }
      } else {
        records.push(...tail.records);
      }
      cache.set(filePath, {
        size,
        mtimeMs,
        provider,
        records,
        parsedBytes: tail.parsedBytes,
        codexState: provider === "codex" ? state : null,
      });
      cacheDirty = true;
      return records;
    }
    const state = createCodexScanState();
    const parsed = await readFileRecords(filePath, provider, 0, state);
    if (parsed === null) return [];
    const records =
      provider === "claude" ? dedupeWithinFile(parsed.records) : parsed.records;
    cache.set(filePath, {
      size,
      mtimeMs,
      provider,
      records,
      parsedBytes: parsed.parsedBytes,
      codexState: provider === "codex" ? state : null,
    });
    cacheDirty = true;
    return records;
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
    const sinceDay = localDayKey(windowStartMs);
    const untilDay = localDayKey(windowEndMs);

    await ensureRates();
    const table: RateTable = rates?.table ?? new Map();
    const roots = await resolveRoots();
    await loadCache();

    const admissionCutoffMs = windowStartMs - MTIME_SLACK_MS;
    const buckets = new Map<string, UsageBucket>();
    const seenKeys = new Set<string>();
    const landedSessions = new Set<string>();
    let scannedFiles = 0;
    let duplicatesDropped = 0;
    const livePaths = new Set<string>();

    // Files are sorted per root so aggregation order — and with it the
    // first-record-wins global dedupe — is deterministic across scans.
    const tasks: { provider: UsageProvider; filePath: string }[] = [];
    for (const root of roots) {
      for (const filePath of (await walkJsonl(root.dir)).sort()) {
        livePaths.add(filePath);
        tasks.push({ provider: root.provider, filePath });
      }
    }

    // stat+parse concurrently; results land by index so the sequential
    // aggregation below sees them in task order. Null = skipped (stale
    // mtime, or vanished between readdir and stat).
    const results: (UsageRecord[] | null)[] = new Array(tasks.length).fill(
      null,
    );
    let nextTask = 0;
    await Promise.all(
      Array.from(
        { length: Math.min(CONCURRENT_FILE_READS, tasks.length) },
        async () => {
          while (true) {
            const index = nextTask++;
            if (index >= tasks.length) return;
            const task = tasks[index]!;
            let stats: Stats;
            try {
              stats = await fs.stat(task.filePath);
            } catch {
              continue; // vanished between readdir and stat
            }
            if (stats.mtimeMs < admissionCutoffMs) continue;
            results[index] = await fileRecords(
              task.filePath,
              task.provider,
              stats.size,
              stats.mtimeMs,
            );
          }
        },
      ),
    );

    for (let index = 0; index < tasks.length; index += 1) {
      const parsed = results[index];
      // Sparse slots (mtime-skipped, vanished mid-walk) stay unset.
      if (parsed == null) continue;
      const provider = tasks[index]!.provider;
      scannedFiles += 1;
      for (const record of parsed) {
        if (
          record.timestampMs < windowStartMs ||
          record.timestampMs >= windowEndMs
        ) {
          continue;
        }
        const day = localDayKey(record.timestampMs);
        if (resolution === "day" && (day < sinceDay || day > untilDay)) {
          continue;
        }
        // Global dedupe: resumed/forked Claude sessions copy records
        // across transcripts; first record wins.
        if (record.dedupeKey !== null) {
          const key = `${provider} ${record.dedupeKey}`;
          if (seenKeys.has(key)) {
            duplicatesDropped += 1;
            continue;
          }
          seenKeys.add(key);
        }
        if (record.sessionId) {
          landedSessions.add(`${provider} ${record.sessionId}`);
        }
        const hourStart =
          resolution === "hour"
            ? new Date(
                windowStartMs +
                  Math.floor((record.timestampMs - windowStartMs) / HOUR_MS) *
                    HOUR_MS,
              ).toISOString()
            : undefined;
        const bucketKey = `${day} ${hourStart ?? ""} ${provider} ${record.model}`;
        let bucket = buckets.get(bucketKey);
        if (!bucket) {
          bucket = {
            day,
            ...(hourStart ? { hourStart } : {}),
            provider: provider,
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
        bucket.tokens.cacheCreationTokens += record.tokens.cacheCreationTokens;
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
