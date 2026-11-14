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
 * after its last rewrite. A compacted table is a few megabytes, so later
 * rewrites take milliseconds; the first one on an old profile reclaims what
 * it accumulated.
 */
export class TableCompactor {
  /** Each table's size right after its last rewrite (or when first seen small). */
  private readonly compactedBytes = new Map<string, number>();
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
        this.options.log?.(
          `Table compaction failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }, intervalMs);
    this.timer.unref?.();
  }

  /** Stop checking and wait for a rewrite in progress. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running?.catch(() => {});
  }

  private async compactTables(): Promise<TableCompaction[]> {
    const done: TableCompaction[] = [];
    for (const table of this.options.tables ?? COMPACTED_TABLES) {
      const bytesBefore = await this.size(table);
      if (bytesBefore === null) continue;
      const compacted = this.compactedBytes.get(table);
      if (
        bytesBefore <= (this.options.floorBytes ?? SIZE_FLOOR_BYTES) ||
        (compacted !== undefined && bytesBefore <= compacted * GROWTH_FACTOR)
      ) {
        if (compacted === undefined)
          this.compactedBytes.set(table, bytesBefore);
        continue;
      }
      const started = performance.now();
      // A listed, schema-qualified name: never interpolated from input.
      await this.pglite.exec(`VACUUM FULL ${table}`);
      const bytesAfter = (await this.size(table)) ?? 0;
      this.compactedBytes.set(table, bytesAfter);
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

function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
