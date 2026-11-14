import type { PGlite } from "@electric-sql/pglite";

/**
 * Tables whose rows are rewritten in place many times over their life: a
 * chat's row on every turn, a turn attempt's progress, the saved workspace
 * on every layout change. Measured on a long-used profile (ADR 0319), only
 * these grew far past their live data; append-mostly tables stay near it.
 */
export const COMPACTED_TABLES = [
  "catamorphic.agent_sessions",
  "catamorphic.agent_turn_attempts",
  "desktop.workspace_states",
] as const;

/** A table smaller than this is never worth a rewrite. */
const SIZE_FLOOR_BYTES = 16 * 1024 * 1024;
/** How far past its compacted size a table may grow before it is rewritten. */
const GROWTH_FACTOR = 4;

export interface TableCompaction {
  table: string;
  bytesBefore: number;
  bytesAfter: number;
  ms: number;
}

/**
 * PGlite runs no autovacuum: every update leaves its old row version on
 * disk, and every read of the table scans past them on the main process.
 * This rewrites a listed table (`VACUUM FULL`) once its size, with indexes
 * and TOAST, passes both the floor and {@link GROWTH_FACTOR} times its size
 * after its last rewrite, which is recorded across launches. A compacted
 * table is a few megabytes, so later rewrites take milliseconds; the first
 * one on an old profile reclaims what it accumulated.
 */
export class TableCompactor {
  /**
   * Each table's size right after its last rewrite, or after a rewrite that
   * failed. Kept in `desktop.table_compactions` so a launch does not rewrite
   * a table whose live data alone is past the floor.
   */
  private compactedBytes: Map<string, number> | null = null;
  private running: Promise<TableCompaction[]> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly pglite: Pick<PGlite, "query" | "exec">,
    private readonly options: {
      tables?: readonly string[];
      /** Smallest size worth a rewrite (tests lower it). */
      floorBytes?: number;
      log?: (message: string) => void;
    } = {},
  ) {}

  /** Rewrite each listed table that grew past its threshold. */
  compact(): Promise<TableCompaction[]> {
    this.running ??= this.compactTables().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /** Check every `intervalMs` until {@link stop}. */
  start({ intervalMs }: { intervalMs: number }): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.compact().catch((error: unknown) =>
        this.options.log?.(`Table compaction failed: ${message(error)}`),
      );
    }, intervalMs);
    this.timer.unref?.();
  }

  /**
   * Stop checking at once, then wait for a rewrite in progress. The timer is
   * cleared before the first await, so a caller need not await to stop it.
   */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running?.catch(() => {});
  }

  private async compactTables(): Promise<TableCompaction[]> {
    const compactedBytes = await this.loadCompactedBytes();
    const done: TableCompaction[] = [];
    for (const table of this.options.tables ?? COMPACTED_TABLES) {
      const bytesBefore = await this.size(table);
      if (bytesBefore === null) continue;
      const compacted = compactedBytes.get(table);
      if (
        bytesBefore <= (this.options.floorBytes ?? SIZE_FLOOR_BYTES) ||
        (compacted !== undefined && bytesBefore <= compacted * GROWTH_FACTOR)
      ) {
        // Small: a baseline for this run. Only rewrites are recorded.
        if (compacted === undefined) compactedBytes.set(table, bytesBefore);
        continue;
      }
      const started = performance.now();
      try {
        // A listed, schema-qualified name: never interpolated from input.
        await this.pglite.exec(`VACUUM FULL ${table}`);
      } catch (error) {
        // Not again until it grows as far once more: a failing rewrite
        // (a full disk) must not stall every pass, nor stop the others.
        await this.record(compactedBytes, table, bytesBefore);
        this.options.log?.(`Could not compact ${table}: ${message(error)}`);
        continue;
      }
      const bytesAfter = (await this.size(table)) ?? 0;
      await this.record(compactedBytes, table, bytesAfter);
      const compaction = {
        table,
        bytesBefore,
        bytesAfter,
        ms: Math.round(performance.now() - started),
      };
      this.options.log?.(
        `Compacted ${table}: ${megabytes(bytesBefore)} to ${megabytes(bytesAfter)} in ${compaction.ms} ms`,
      );
      done.push(compaction);
    }
    return done;
  }

  private async loadCompactedBytes(): Promise<Map<string, number>> {
    if (this.compactedBytes) return this.compactedBytes;
    await this.pglite.exec(`
      CREATE SCHEMA IF NOT EXISTS desktop;
      CREATE TABLE IF NOT EXISTS desktop.table_compactions (
        table_name      text PRIMARY KEY,
        compacted_bytes bigint NOT NULL,
        compacted_at    timestamptz NOT NULL DEFAULT now()
      );
    `);
    const rows = await this.pglite.query<{
      table_name: string;
      compacted_bytes: string;
    }>(
      "SELECT table_name, compacted_bytes::text FROM desktop.table_compactions",
    );
    this.compactedBytes = new Map(
      rows.rows.map((row) => [row.table_name, Number(row.compacted_bytes)]),
    );
    return this.compactedBytes;
  }

  private async record(
    compactedBytes: Map<string, number>,
    table: string,
    bytes: number,
  ): Promise<void> {
    compactedBytes.set(table, bytes);
    await this.pglite.query(
      `INSERT INTO desktop.table_compactions (table_name, compacted_bytes)
       VALUES ($1, $2)
       ON CONFLICT (table_name)
       DO UPDATE SET compacted_bytes = EXCLUDED.compacted_bytes, compacted_at = now()`,
      [table, bytes],
    );
  }

  /** Bytes on disk with indexes and TOAST, or null when the table is absent. */
  private async size(table: string): Promise<number | null> {
    const result = await this.pglite.query<{ bytes: string | null }>(
      "SELECT pg_total_relation_size(to_regclass($1))::text AS bytes",
      [table],
    );
    const bytes = result.rows[0]?.bytes;
    return bytes == null ? null : Number(bytes);
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
