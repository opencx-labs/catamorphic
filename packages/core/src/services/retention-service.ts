import type { DB } from "@catamorphic/db";
import { getTracer, withSpan } from "@catamorphic/otel";
import { type Kysely, sql } from "kysely";

/**
 * How long finished runs are kept before they are purged.
 *
 * Retention is on by default. An installation that never configures it still
 * reclaims storage, because the alternative — unbounded growth by default — is
 * the failure mode this exists to prevent.
 */
export interface RetentionConfig {
  /** Set false to keep every run forever. */
  enabled?: boolean;
  /** Days a terminal run is kept, counted from `completed_at`. */
  runRetentionDays?: number;
  /** Runs deleted per sweep. Bounds the cost of any single transaction. */
  purgeBatchSize?: number;
  /** Minimum gap between sweeps in a worker loop. */
  sweepIntervalMs?: number;
}

export const DEFAULT_RUN_RETENTION_DAYS = 90;
const DEFAULT_PURGE_BATCH_SIZE = 1_000;
const DEFAULT_SWEEP_INTERVAL_MS = 60 * 60 * 1_000;

export interface PurgeResult {
  purgedRuns: number;
}

const tracer = getTracer("@catamorphic/core");

export class RetentionService {
  private readonly enabled: boolean;
  private readonly runRetentionDays: number;
  private readonly purgeBatchSize: number;
  readonly sweepIntervalMs: number;

  constructor(
    private readonly db: Kysely<DB>,
    config: RetentionConfig = {},
  ) {
    this.enabled = config.enabled ?? true;
    this.runRetentionDays = requirePositiveInteger({
      value: config.runRetentionDays ?? DEFAULT_RUN_RETENTION_DAYS,
      name: "runRetentionDays",
    });
    this.purgeBatchSize = requirePositiveInteger({
      value: config.purgeBatchSize ?? DEFAULT_PURGE_BATCH_SIZE,
      name: "purgeBatchSize",
    });
    this.sweepIntervalMs = requirePositiveInteger({
      value: config.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS,
      name: "sweepIntervalMs",
    });
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Delete one bounded batch of aged-out terminal runs.
   *
   * Everything else — jobs, events, step attempts, batch items and their steps
   * and members — hangs off `workflow_runs` by `ON DELETE CASCADE`, so removing
   * the root row reclaims the whole tree in one statement.
   *
   * Returns how many runs were purged. A caller draining a backlog should keep
   * calling until it returns zero.
   */
  async purgeExpiredRuns(args: { limit?: number } = {}): Promise<PurgeResult> {
    if (!this.enabled) return { purgedRuns: 0 };
    const limit = Math.max(
      1,
      Math.min(args.limit ?? this.purgeBatchSize, 50_000),
    );
    return withSpan(
      {
        tracer,
        name: "retention.purge_expired_runs",
        attributes: {
          "catamorphic.retention.default_days": this.runRetentionDays,
          "catamorphic.retention.limit": limit,
        },
      },
      async (span) => {
        const rows = await sql<{ id: string }>`
          WITH RECURSIVE cutoff AS (
            -- Resolve each project's cutoff instant first, so the scan below
            -- compares completed_at against a constant per project and can use
            -- idx_workflow_runs_retention as an index condition. Joining the
            -- policy in the same scan would make the comparison depend on a
            -- joined column, which forces a sequential scan of all history.
            SELECT
              projects.id AS project_id,
              clock_timestamp()
                - (COALESCE(policy.retention_days, ${this.runRetentionDays})
                   * interval '1 day') AS purge_before
            FROM projects
            LEFT JOIN tenant_execution_policies AS policy
              ON policy.tenant_id = projects.tenant_id
          ),
          candidates AS (
            SELECT run.id, run.completed_at
            FROM cutoff
            JOIN LATERAL (
              SELECT candidate.id, candidate.completed_at
              FROM workflow_runs AS candidate
              WHERE candidate.project_id = cutoff.project_id
                AND candidate.status IN ('completed', 'failed', 'canceled')
                AND candidate.completed_at IS NOT NULL
                AND candidate.completed_at < cutoff.purge_before
                -- A run whose parent is also being purged would be deleted
                -- twice: once here and once by the parent's cascade. Purging
                -- roots only keeps each tree to a single delete, and children
                -- age out with the parent that owns them.
                AND candidate.parent_run_id IS NULL
              ORDER BY candidate.completed_at
              LIMIT ${limit}
            ) AS run ON true
            ORDER BY run.completed_at
            LIMIT ${limit}
          ),
          -- Walk every candidate's descendants once, as a set. Testing each
          -- candidate with its own recursive subquery costs ~50x more, because
          -- the CTE is re-planned and re-executed per row.
          tree AS (
            SELECT candidates.id AS root_id, candidates.id
            FROM candidates
            UNION ALL
            SELECT tree.root_id, child.id
            FROM workflow_runs AS child
            JOIN tree ON child.parent_run_id = tree.id
          ),
          -- A parent can go terminal while a descendant is still live (the
          -- parent failed before its child was cancelled). The cascade is
          -- recursive, so this check must be too: a terminal direct child can
          -- itself hold a running grandchild, and deleting the root would
          -- destroy that in-flight work. Leave the whole tree until every run
          -- under it has settled.
          blocked AS (
            SELECT DISTINCT tree.root_id
            FROM tree
            JOIN workflow_runs AS descendant ON descendant.id = tree.id
            WHERE descendant.status NOT IN ('completed', 'failed', 'canceled')
          )
          DELETE FROM workflow_runs
          WHERE id IN (
            SELECT candidates.id
            FROM candidates
            WHERE NOT EXISTS (
              SELECT 1 FROM blocked WHERE blocked.root_id = candidates.id
            )
          )
          RETURNING id
        `.execute(this.db);
        span.setAttribute(
          "catamorphic.retention.purged_runs",
          rows.rows.length,
        );
        return { purgedRuns: rows.rows.length };
      },
    );
  }
}

function requirePositiveInteger(args: { value: number; name: string }): number {
  if (!Number.isInteger(args.value) || args.value <= 0) {
    throw new Error(`Retention ${args.name} must be a positive integer`);
  }
  return args.value;
}
