import type { DB, Json } from "@catamorphic/db";
import { getTracer, withSpan } from "@catamorphic/otel";
import { type Kysely, type Selectable, sql, type Transaction } from "kysely";

export type ExecutionJobKind =
  | "workflow_run"
  | "durable_boundary"
  | "durable_pause_timeout"
  | "batch_source"
  | "batch_item"
  | "batch_step"
  | "batch_sink";

export type ExecutionJobStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "canceled";

type ExecutionJobRow = Selectable<DB["execution_jobs"]>;

export interface ExecutionJob {
  id: string;
  tenantId: string;
  workflowRunId: string;
  workflowStepAttemptId: string | null;
  kind: ExecutionJobKind;
  payload: Json;
  status: ExecutionJobStatus;
  priority: number;
  availableAt: string;
  attempt: number;
  maxAttempts: number;
  leasedBy: string | null;
  leaseToken: string | null;
  leaseGeneration: string;
  leaseExpiresAt: string | null;
  dedupeKey: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  exhaustionHandledAt: string | null;
}

const tracer = getTracer("@catamorphic/core");

/**
 * Dedupe-conflict resolution shared by every enqueue path.
 *
 * A live row absorbs the duplicate, which is what dedupe is for. A terminal one
 * must be revived instead: the caller is asking for work that no longer exists,
 * and leaving the row terminal strands whatever was waiting on it with nothing
 * to claim.
 */
function reviveTerminalJob(eb: {
  ref: (column: string) => unknown;
}): Record<string, unknown> {
  const status = eb.ref("execution_jobs.status");
  const isTerminal = sql<boolean>`${status} IN ('completed', 'failed', 'canceled')`;
  return {
    status: sql<string>`CASE WHEN ${isTerminal} THEN 'pending' ELSE ${status} END`,
    attempt: sql<number>`CASE WHEN ${isTerminal} THEN 0 ELSE ${eb.ref("execution_jobs.attempt")} END`,
    available_at: sql<Date>`CASE WHEN ${isTerminal} THEN excluded.available_at ELSE ${eb.ref("execution_jobs.available_at")} END`,
    payload: sql<Json>`CASE WHEN ${isTerminal} THEN excluded.payload ELSE ${eb.ref("execution_jobs.payload")} END`,
    completed_at: sql<Date | null>`CASE WHEN ${isTerminal} THEN NULL ELSE ${eb.ref("execution_jobs.completed_at")} END`,
    last_error: sql<
      string | null
    >`CASE WHEN ${isTerminal} THEN NULL ELSE ${eb.ref("execution_jobs.last_error")} END`,
    exhaustion_handled_at: sql<Date | null>`CASE WHEN ${isTerminal} THEN NULL ELSE ${eb.ref("execution_jobs.exhaustion_handled_at")} END`,
    exhaustion_handled: sql<boolean>`CASE WHEN ${isTerminal} THEN false ELSE ${eb.ref("execution_jobs.exhaustion_handled")} END`,
    updated_at: new Date(),
  };
}

/**
 * How long an exhaustion claim is honoured before a sweep may retake it.
 *
 * The terminal handler runs a handful of statements, so anything alive
 * finishes well inside this. Long enough that a healthy-but-slow handler is
 * not double-run; short enough that a crashed claimer delays the run's
 * terminal failure by minutes, not forever.
 */
const EXHAUSTION_CLAIM_MS = 10 * 60 * 1_000;

export class ExecutionJobsService {
  constructor(private readonly db: Kysely<DB>) {}

  async enqueue(args: {
    tenantId: string;
    kind: ExecutionJobKind;
    payload: Json;
    priority?: number;
    availableAt?: Date;
    maxAttempts?: number;
    dedupeKey?: string;
    workflowRunId: string;
    workflowStepAttemptId?: string;
    trx?: Transaction<DB>;
  }): Promise<ExecutionJob> {
    return withSpan(
      {
        tracer,
        name: "queue.enqueue",
        attributes: {
          "catamorphic.tenant.id": args.tenantId,
          "catamorphic.queue.job.kind": args.kind,
          "catamorphic.queue.job.priority": args.priority ?? 0,
          "catamorphic.run.id": args.workflowRunId,
        },
      },
      async (span) => {
        const database = args.trx ?? this.db;
        const row = await database
          .insertInto("execution_jobs")
          .values({
            tenant_id: args.tenantId,
            kind: args.kind,
            payload: args.payload,
            priority: args.priority ?? 0,
            available_at: args.availableAt ?? sql<Date>`clock_timestamp()`,
            max_attempts: args.maxAttempts ?? 5,
            dedupe_key: args.dedupeKey ?? null,
            workflow_run_id: args.workflowRunId,
            workflow_step_attempt_id: args.workflowStepAttemptId ?? null,
          })
          .onConflict((conflict) =>
            conflict
              .columns(["tenant_id", "dedupe_key"])
              .where("dedupe_key", "is not", null)
              .doUpdateSet(reviveTerminalJob),
          )
          .returningAll()
          .executeTakeFirstOrThrow();
        span.setAttribute("catamorphic.queue.job.id", row.id);
        return mapExecutionJob(row);
      },
    );
  }

  /**
   * Enqueues many jobs in one statement.
   *
   * Fan-out paths enqueue one job per item, and a per-item round trip makes
   * page acceptance and batch-step resumption scale with item count rather
   * than page count. Dedupe semantics are identical to {@link enqueue}.
   *
   * Rows sharing a dedupe key within one call would make the statement's own
   * ON CONFLICT ambiguous, so they are collapsed first — last write wins, which
   * matches what sequential enqueues would have left behind.
   */
  async enqueueMany(args: {
    jobs: readonly {
      tenantId: string;
      kind: ExecutionJobKind;
      payload: Json;
      priority?: number;
      availableAt?: Date;
      maxAttempts?: number;
      dedupeKey?: string;
      workflowRunId: string;
      workflowStepAttemptId?: string;
    }[];
    trx?: Transaction<DB>;
  }): Promise<void> {
    if (args.jobs.length === 0) return;
    const deduped = [...args.jobs];
    const lastByKey = new Map<string, number>();
    for (const [index, job] of deduped.entries()) {
      if (!job.dedupeKey) continue;
      lastByKey.set(`${job.tenantId} ${job.dedupeKey}`, index);
    }
    const rows = deduped.filter(
      (job, index) =>
        !job.dedupeKey ||
        lastByKey.get(`${job.tenantId} ${job.dedupeKey}`) === index,
    );

    await withSpan(
      {
        tracer,
        name: "queue.enqueue_many",
        attributes: { "catamorphic.queue.job.count": rows.length },
      },
      async () => {
        const database = args.trx ?? this.db;
        await database
          .insertInto("execution_jobs")
          .values(
            rows.map((job) => ({
              tenant_id: job.tenantId,
              kind: job.kind,
              payload: job.payload,
              priority: job.priority ?? 0,
              available_at: job.availableAt ?? sql<Date>`clock_timestamp()`,
              max_attempts: job.maxAttempts ?? 5,
              dedupe_key: job.dedupeKey ?? null,
              workflow_run_id: job.workflowRunId,
              workflow_step_attempt_id: job.workflowStepAttemptId ?? null,
            })),
          )
          .onConflict((conflict) =>
            conflict
              .columns(["tenant_id", "dedupe_key"])
              .where("dedupe_key", "is not", null)
              .doUpdateSet(reviveTerminalJob),
          )
          .execute();
      },
    );
  }

  async claim(args: {
    workerId: string;
    kinds: readonly ExecutionJobKind[];
    limit?: number;
    leaseSeconds?: number;
  }): Promise<ExecutionJob[]> {
    if (args.kinds.length === 0) return [];
    const limit = Math.max(1, Math.min(args.limit ?? 10, 100));
    const leaseSeconds = args.leaseSeconds ?? 60;
    const leaseToken = crypto.randomUUID();

    return withSpan(
      {
        tracer,
        name: "queue.claim",
        attributes: {
          "catamorphic.queue.worker_id": args.workerId,
          "catamorphic.queue.claim_limit": limit,
        },
      },
      (span) =>
        this.db.transaction().execute(async (trx) => {
          const ids = await selectClaimableJobs({
            trx,
            kinds: args.kinds,
            limit,
          });
          if (ids.length === 0) {
            span.setAttribute("catamorphic.queue.claimed_count", 0);
            return [];
          }

          const rows = await trx
            .updateTable("execution_jobs")
            .set((eb) => ({
              status: "running",
              leased_by: args.workerId,
              lease_token: leaseToken,
              lease_generation: sql<string>`lease_generation + 1`,
              heartbeat_at: sql<Date>`clock_timestamp()`,
              lease_expires_at: sql<Date>`clock_timestamp() + (${leaseSeconds} * interval '1 second')`,
              attempt: eb("attempt", "+", 1),
              updated_at: new Date(),
            }))
            .where("id", "in", ids)
            .where("status", "=", "pending")
            .returningAll()
            .execute();
          span.setAttribute("catamorphic.queue.claimed_count", rows.length);
          span.setAttribute(
            "catamorphic.queue.tenant_count",
            new Set(rows.map((row) => row.tenant_id)).size,
          );
          return rows.map(mapExecutionJob);
        }),
    );
  }

  /**
   * Claims one specific pending, currently-available job. Used by sync
   * trigger firings to drive a run's jobs inline; losing the race to a
   * polling worker returns null, never an error.
   */
  async claimById(args: {
    jobId: string;
    workerId: string;
    leaseSeconds?: number;
  }): Promise<ExecutionJob | null> {
    const leaseSeconds = args.leaseSeconds ?? 60;
    const leaseToken = crypto.randomUUID();
    const row = await this.db
      .updateTable("execution_jobs")
      .set((eb) => ({
        status: "running",
        leased_by: args.workerId,
        lease_token: leaseToken,
        lease_generation: sql<string>`lease_generation + 1`,
        heartbeat_at: sql<Date>`clock_timestamp()`,
        lease_expires_at: sql<Date>`clock_timestamp() + (${leaseSeconds} * interval '1 second')`,
        attempt: eb("attempt", "+", 1),
        updated_at: new Date(),
      }))
      .where("id", "=", args.jobId)
      .where("status", "=", "pending")
      .where("available_at", "<=", sql<Date>`clock_timestamp()`)
      .returningAll()
      .executeTakeFirst();
    return row ? mapExecutionJob(row) : null;
  }

  /**
   * The next job a sync driver would run for this run: the oldest
   * non-terminal job, pending or already claimed by someone else.
   */
  async nextForRun(args: {
    tenantId: string;
    runId: string;
  }): Promise<ExecutionJob | null> {
    const row = await this.db
      .selectFrom("execution_jobs")
      .selectAll()
      .where("tenant_id", "=", args.tenantId)
      .where("workflow_run_id", "=", args.runId)
      .where("status", "in", ["pending", "running"])
      .orderBy("created_at", "asc")
      .orderBy("id", "asc")
      .limit(1)
      .executeTakeFirst();
    return row ? mapExecutionJob(row) : null;
  }

  async heartbeat(args: {
    jobId: string;
    workerId: string;
    leaseToken: string;
    leaseGeneration: string;
    leaseSeconds?: number;
  }): Promise<boolean> {
    const result = await this.db
      .updateTable("execution_jobs")
      .set({
        lease_expires_at: sql<Date>`clock_timestamp() + (${args.leaseSeconds ?? 60} * interval '1 second')`,
        heartbeat_at: sql<Date>`clock_timestamp()`,
        updated_at: sql<Date>`clock_timestamp()`,
      })
      .where("id", "=", args.jobId)
      .where("status", "=", "running")
      .where("leased_by", "=", args.workerId)
      .where("lease_token", "=", args.leaseToken)
      .where("lease_generation", "=", args.leaseGeneration)
      .where("lease_expires_at", ">", sql<Date>`clock_timestamp()`)
      .executeTakeFirst();
    return Number(result.numUpdatedRows) === 1;
  }

  async complete(args: {
    jobId: string;
    workerId: string;
    leaseToken: string;
    leaseGeneration: string;
  }): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      const now = await databaseNow(trx);
      const result = await trx
        .updateTable("execution_jobs")
        .set({
          status: "completed",
          leased_by: null,
          lease_token: null,
          heartbeat_at: null,
          lease_expires_at: null,
          completed_at: now,
          updated_at: now,
        })
        .where("id", "=", args.jobId)
        .where("status", "=", "running")
        .where("leased_by", "=", args.workerId)
        .where("lease_token", "=", args.leaseToken)
        .where("lease_generation", "=", args.leaseGeneration)
        .where("lease_expires_at", ">", sql<Date>`clock_timestamp()`)
        .executeTakeFirst();
      if (Number(result.numUpdatedRows) !== 1) return false;
      await deleteLeaseInvocations({ trx, ...args });
      return true;
    });
  }

  async fail(args: {
    jobId: string;
    workerId: string;
    leaseToken: string;
    leaseGeneration: string;
    error: string;
    retryAt?: Date;
  }): Promise<ExecutionJobStatus | null> {
    return this.db.transaction().execute(async (trx) => {
      const row = await trx
        .selectFrom("execution_jobs")
        .where("id", "=", args.jobId)
        .where("status", "=", "running")
        .where("leased_by", "=", args.workerId)
        .where("lease_token", "=", args.leaseToken)
        .where("lease_generation", "=", args.leaseGeneration)
        .where("lease_expires_at", ">", sql<Date>`clock_timestamp()`)
        .select(["attempt", "max_attempts"])
        .forUpdate()
        .executeTakeFirst();
      if (!row) return null;

      const retry = row.attempt < row.max_attempts;
      const status: ExecutionJobStatus = retry ? "pending" : "failed";
      const updated = await trx
        .updateTable("execution_jobs")
        .set({
          status,
          available_at: retry
            ? (args.retryAt ?? retryDate(row.attempt))
            : new Date(),
          leased_by: null,
          lease_token: null,
          heartbeat_at: null,
          lease_expires_at: null,
          last_error: args.error,
          completed_at: retry ? null : new Date(),
          updated_at: new Date(),
        })
        .where("id", "=", args.jobId)
        .where("status", "=", "running")
        .where("leased_by", "=", args.workerId)
        .where("lease_token", "=", args.leaseToken)
        .where("lease_generation", "=", args.leaseGeneration)
        .where("lease_expires_at", ">", sql<Date>`clock_timestamp()`)
        .returning("status")
        .executeTakeFirst();
      if (updated) await deleteLeaseInvocations({ trx, ...args });
      return updated ? status : null;
    });
  }

  async release(args: {
    jobId: string;
    workerId: string;
    leaseToken: string;
    leaseGeneration: string;
    availableAt: Date;
    /**
     * When set, `availableAt` applies only while this run is still paused.
     *
     * A job that observed a paused run parks itself an hour out, but the
     * resume that should wake it only pulls forward `pending` jobs — a job
     * still leased when the resume commits would sleep out the full park.
     * Locking the run here serializes with `resumeOperator`'s run lock, so
     * either the resume sees this job pending and wakes it, or this release
     * sees the resumed status and comes back immediately.
     */
    parkedForPausedRunId?: string;
  }): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      let availableAt = args.availableAt;
      if (args.parkedForPausedRunId) {
        const run = await trx
          .selectFrom("workflow_runs")
          .where("id", "=", args.parkedForPausedRunId)
          .select("status")
          .forShare()
          .executeTakeFirst();
        if (run?.status !== "paused") availableAt = new Date();
      }
      const result = await trx
        .updateTable("execution_jobs")
        .set((eb) => ({
          status: "pending",
          available_at: availableAt,
          leased_by: null,
          lease_token: null,
          heartbeat_at: null,
          lease_expires_at: null,
          attempt: eb("attempt", "-", 1),
          updated_at: new Date(),
        }))
        .where("id", "=", args.jobId)
        .where("status", "=", "running")
        .where("leased_by", "=", args.workerId)
        .where("lease_token", "=", args.leaseToken)
        .where("lease_generation", "=", args.leaseGeneration)
        .where("lease_expires_at", ">", sql<Date>`clock_timestamp()`)
        .executeTakeFirst();
      if (Number(result.numUpdatedRows) !== 1) return false;
      await deleteLeaseInvocations({ trx, ...args });
      return true;
    });
  }

  async cancel(args: { jobId: string }): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      const now = await databaseNow(trx);
      const result = await trx
        .updateTable("execution_jobs")
        .set({
          status: "canceled",
          leased_by: null,
          lease_token: null,
          heartbeat_at: null,
          lease_expires_at: null,
          completed_at: now,
          updated_at: now,
        })
        .where("id", "=", args.jobId)
        .where("status", "in", ["pending", "running"])
        .executeTakeFirst();
      if (Number(result.numUpdatedRows) !== 1) return false;
      await trx
        .deleteFrom("active_run_invocations")
        .where("execution_job_id", "=", args.jobId)
        .execute();
      return true;
    });
  }

  async cancelByDedupeKey(args: {
    tenantId: string;
    dedupeKey: string;
  }): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      const now = await databaseNow(trx);
      const jobs = await trx
        .updateTable("execution_jobs")
        .set({
          status: "canceled",
          leased_by: null,
          lease_token: null,
          heartbeat_at: null,
          lease_expires_at: null,
          completed_at: now,
          updated_at: now,
        })
        .where("tenant_id", "=", args.tenantId)
        .where("dedupe_key", "=", args.dedupeKey)
        .where("status", "in", ["pending", "running"])
        .returning("id")
        .execute();
      if (jobs.length === 0) return false;
      await trx
        .deleteFrom("active_run_invocations")
        .where(
          "execution_job_id",
          "in",
          jobs.map((job) => job.id),
        )
        .execute();
      return true;
    });
  }

  async cancelByDedupePrefix(args: {
    tenantId: string;
    dedupePrefix: string;
  }): Promise<number> {
    return this.db.transaction().execute(async (trx) => {
      const now = await databaseNow(trx);
      const jobs = await trx
        .updateTable("execution_jobs")
        .set({
          status: "canceled",
          leased_by: null,
          lease_token: null,
          heartbeat_at: null,
          lease_expires_at: null,
          completed_at: now,
          updated_at: now,
        })
        .where("tenant_id", "=", args.tenantId)
        .where("dedupe_key", "like", `${escapeLike(args.dedupePrefix)}%`)
        .where("status", "in", ["pending", "running"])
        .returning("id")
        .execute();
      if (jobs.length === 0) return 0;
      await trx
        .deleteFrom("active_run_invocations")
        .where(
          "execution_job_id",
          "in",
          jobs.map((job) => job.id),
        )
        .execute();
      return jobs.length;
    });
  }

  async makeAvailable(args: {
    tenantId: string;
    dedupeKey: string;
    availableAt?: Date;
  }): Promise<void> {
    const availableAt = args.availableAt ?? sql<Date>`clock_timestamp()`;
    await this.db
      .updateTable("execution_jobs")
      .set({
        available_at: availableAt,
        updated_at: new Date(),
      })
      .where("tenant_id", "=", args.tenantId)
      .where("dedupe_key", "=", args.dedupeKey)
      .where("status", "=", "pending")
      .where("available_at", ">", availableAt)
      .execute();
  }

  /**
   * Pull a run's parked jobs forward so they are claimable now.
   *
   * Work deferred while a run was paused is parked far in the future rather
   * than re-polled, so nothing spins against a paused run. That trades polling
   * for an explicit wake: whoever makes the run runnable again must call this,
   * or its jobs wait out the parking interval.
   */
  async makeRunAvailable(args: {
    runId: string;
    availableAt?: Date;
  }): Promise<number> {
    const availableAt = args.availableAt ?? sql<Date>`clock_timestamp()`;
    const result = await this.db
      .updateTable("execution_jobs")
      .set({
        available_at: availableAt,
        updated_at: new Date(),
      })
      .where("workflow_run_id", "=", args.runId)
      .where("status", "=", "pending")
      .where("available_at", ">", availableAt)
      .executeTakeFirst();
    return Number(result.numUpdatedRows);
  }

  async redrive(args: {
    tenantId: string;
    jobId: string;
    availableAt?: Date;
  }): Promise<boolean> {
    const result = await this.db
      .updateTable("execution_jobs")
      .set({
        status: "pending",
        attempt: 0,
        available_at: args.availableAt ?? sql<Date>`clock_timestamp()`,
        leased_by: null,
        lease_token: null,
        heartbeat_at: null,
        lease_expires_at: null,
        last_error: null,
        completed_at: null,
        exhaustion_handled_at: null,
        exhaustion_handled: false,
        updated_at: new Date(),
      })
      .where("id", "=", args.jobId)
      .where("tenant_id", "=", args.tenantId)
      .where("status", "=", "failed")
      .executeTakeFirst();
    return Number(result.numUpdatedRows) === 1;
  }

  async requeueExpired(args: { limit?: number } = {}): Promise<number> {
    return this.db.transaction().execute(async (trx) => {
      const expired = await trx
        .selectFrom("execution_jobs")
        .where("status", "=", "running")
        .where("lease_expires_at", "<=", sql<Date>`clock_timestamp()`)
        .selectAll()
        .orderBy("lease_expires_at", "asc")
        .forUpdate()
        .skipLocked()
        .limit(Math.max(1, Math.min(args.limit ?? 100, 1_000)))
        .execute();
      if (expired.length === 0) return 0;
      const retryableIds = expired
        .filter((row) => row.attempt < row.max_attempts)
        .map((row) => row.id);
      const exhaustedIds = expired
        .filter((row) => row.attempt >= row.max_attempts)
        .map((row) => row.id);
      const now = await databaseNow(trx);
      const retryError = "Execution job lease expired before completion";
      let requeued = 0;
      if (retryableIds.length > 0) {
        const result = await trx
          .updateTable("execution_jobs")
          .set({
            status: "pending",
            leased_by: null,
            lease_token: null,
            heartbeat_at: null,
            lease_expires_at: null,
            available_at: now,
            last_error: retryError,
            updated_at: now,
          })
          .where("id", "in", retryableIds)
          .where("status", "=", "running")
          .where("lease_expires_at", "<=", now)
          .executeTakeFirst();
        requeued = Number(result.numUpdatedRows);
        await trx
          .deleteFrom("active_run_invocations")
          .where("execution_job_id", "in", retryableIds)
          .execute();
      }
      const exhausted =
        exhaustedIds.length === 0
          ? []
          : await trx
              .updateTable("execution_jobs")
              .set({
                status: "failed",
                leased_by: null,
                lease_token: null,
                heartbeat_at: null,
                lease_expires_at: null,
                last_error: retryError,
                completed_at: now,
                updated_at: now,
              })
              .where("id", "in", exhaustedIds)
              .where("status", "=", "running")
              .where("lease_expires_at", "<=", now)
              .returningAll()
              .execute();
      if (exhausted.length > 0) {
        await trx
          .deleteFrom("active_run_invocations")
          .where(
            "execution_job_id",
            "in",
            exhausted.map((row) => row.id),
          )
          .execute();
      }
      return requeued + exhausted.length;
    });
  }

  /**
   * Atomically takes ownership of exhausted jobs needing their terminal handler.
   *
   * Reading the unhandled set and marking it afterwards let every loop in every
   * process see the same rows and run the handler once each — the side effect
   * (failing the step, failing the run) is not idempotent, so it fired N times
   * per job. Stamping `exhaustion_handled_at` in the same statement that
   * selects makes the claim exclusive, and `SKIP LOCKED` keeps concurrent
   * claimers from queueing behind one another.
   *
   * The stamp is a claim, not a receipt. A handler that fails must call
   * {@link releaseExhaustionClaim} so the job is retried rather than stranded,
   * and a handler that succeeds must call {@link confirmExhaustionHandled} —
   * a crash between claim and receipt leaves only a stamp, which expires
   * after {@link EXHAUSTION_CLAIM_MS} and gets reclaimed by a later sweep.
   * The handler tolerates the resulting rare re-run: it no-ops against a
   * step or run that is already terminal.
   */
  async claimExhausted(args: { limit?: number }): Promise<ExecutionJob[]> {
    const limit = Math.max(1, Math.min(args.limit ?? 100, 1_000));
    const rows = await this.db
      .updateTable("execution_jobs")
      .set({ exhaustion_handled_at: sql<Date>`clock_timestamp()` })
      .where(({ eb, selectFrom, or }) =>
        eb(
          "id",
          "in",
          selectFrom("execution_jobs")
            .select("id")
            .where("status", "=", "failed")
            .where("exhaustion_handled", "=", false)
            .where(
              or([
                eb("exhaustion_handled_at", "is", null),
                eb(
                  "exhaustion_handled_at",
                  "<",
                  sql<Date>`clock_timestamp() - make_interval(secs => ${EXHAUSTION_CLAIM_MS / 1_000})`,
                ),
              ]),
            )
            .orderBy("completed_at", "asc")
            .limit(limit)
            .forUpdate()
            .skipLocked(),
        ),
      )
      .returningAll()
      .execute();
    return rows.map(mapExecutionJob);
  }

  /**
   * Claims one exhausted job, for the worker that just exhausted it inline.
   *
   * Returns false when a sweep already holds a live claim (or the receipt is
   * already written), so the terminal handler runs once no matter which path
   * reaches the job first.
   */
  async claimExhaustionFor(args: { jobId: string }): Promise<boolean> {
    const result = await this.db
      .updateTable("execution_jobs")
      .set({ exhaustion_handled_at: sql<Date>`clock_timestamp()` })
      .where("id", "=", args.jobId)
      .where("status", "=", "failed")
      .where("exhaustion_handled", "=", false)
      .where(({ eb, or }) =>
        or([
          eb("exhaustion_handled_at", "is", null),
          eb(
            "exhaustion_handled_at",
            "<",
            sql<Date>`clock_timestamp() - make_interval(secs => ${EXHAUSTION_CLAIM_MS / 1_000})`,
          ),
        ]),
      )
      .executeTakeFirst();
    return Number(result.numUpdatedRows) === 1;
  }

  /** Writes the receipt: the terminal handler's side effect has landed. */
  async confirmExhaustionHandled(args: { jobId: string }): Promise<void> {
    await this.db
      .updateTable("execution_jobs")
      .set({ exhaustion_handled: true })
      .where("id", "=", args.jobId)
      .execute();
  }

  /** Returns a claimed job to the unhandled set after its handler failed. */
  async releaseExhaustionClaim(args: { jobId: string }): Promise<void> {
    await this.db
      .updateTable("execution_jobs")
      .set({ exhaustion_handled_at: null })
      .where("id", "=", args.jobId)
      .where("status", "=", "failed")
      .execute();
  }
}

async function deleteLeaseInvocations(args: {
  trx: Transaction<DB>;
  jobId: string;
  leaseToken: string;
  leaseGeneration: string;
}): Promise<void> {
  await args.trx
    .deleteFrom("active_run_invocations")
    .where("execution_job_id", "=", args.jobId)
    .where("lease_token", "=", args.leaseToken)
    .where("lease_generation", "=", args.leaseGeneration)
    .execute();
}

function retryDate(attempt: number): Date {
  const delaySeconds = Math.min(300, 2 ** Math.min(attempt, 8));
  return new Date(Date.now() + delaySeconds * 1_000);
}

async function databaseNow(trx: Transaction<DB>): Promise<Date> {
  const result = await sql<{
    now: Date;
  }>`SELECT clock_timestamp() AS now`.execute(trx);
  const now = result.rows[0]?.now;
  if (!now) throw new Error("Database did not return the current time");
  return now;
}

/**
 * Picks the next batch of jobs, fairly but without wasting capacity.
 *
 * Every eligible tenant gets a floor of one job before any tenant gets a
 * second, which preserves anti-starvation. Remaining slots are then backfilled
 * from the global pending set in rank order, so one tenant running a large
 * campaign can saturate an otherwise idle system instead of being pinned to one
 * job per poll. `queue_weight` scales how deep into a tenant's own backlog the
 * backfill will reach, and `max_concurrent_jobs` caps its leased total.
 *
 * Runs as one set-based statement: ranking, policy joins, and the eligibility
 * cutoff all happen inside Postgres.
 *
 * Cost is bounded by the number of tenants holding pending work, not by the
 * depth of the backlog. `tenant_walk` skips between distinct tenants through
 * idx_execution_jobs_pending_rank, then each tenant contributes only its own
 * top slice via LATERAL. Ranking the whole pending set instead would sort every
 * pending row on every poll — measured at 400ms for one claim against a 300k
 * backlog, versus sub-millisecond here.
 *
 * `max_concurrent_jobs` is a best-effort ceiling, not a hard semaphore: two
 * workers claiming at the same instant can read the same leased count and
 * together overshoot it by up to one batch. Bounding cost is what this is for,
 * and the next poll self-corrects; anything needing exactness would have to
 * serialize claims per tenant, which is the throughput problem being fixed.
 */
async function selectClaimableJobs(args: {
  trx: Transaction<DB>;
  kinds: readonly ExecutionJobKind[];
  limit: number;
}): Promise<string[]> {
  const kinds = [...args.kinds];
  // Postgres cannot estimate a recursive CTE's cardinality, so it guesses high
  // enough to trigger JIT on a query that touches a few dozen index entries.
  // Compilation then costs ~20ms against ~0.3ms of execution. Local to the
  // transaction, so it does not affect the handler work that follows.
  await sql`SET LOCAL jit = off`.execute(args.trx);
  const rows = await sql<{ id: string }>`
    WITH RECURSIVE tenant_walk AS (
      -- Skip-scan the distinct tenants holding pending work. Reading them from
      -- the job index rather than from tenants keeps the walk proportional to
      -- tenants with a backlog, not to every tenant on the installation.
      (
        SELECT tenant_id
        FROM execution_jobs
        WHERE status = 'pending'
        ORDER BY tenant_id
        LIMIT 1
      )
      UNION ALL
      SELECT (
        SELECT job.tenant_id
        FROM execution_jobs AS job
        WHERE job.status = 'pending'
          AND job.tenant_id > walk.tenant_id
        ORDER BY job.tenant_id
        LIMIT 1
      )
      FROM tenant_walk AS walk
      WHERE walk.tenant_id IS NOT NULL
    ),
    policy AS (
      SELECT
        tenant_id,
        max_concurrent_jobs,
        queue_weight,
        jobs_enabled
      FROM tenant_execution_policies
    ),
    candidate_tenants AS (
      SELECT
        walk.tenant_id,
        COALESCE(policy.queue_weight, 1) AS queue_weight,
        policy.max_concurrent_jobs,
        COALESCE((
          SELECT count(*)
          FROM execution_jobs AS leased
          WHERE leased.status = 'running'
            AND leased.tenant_id = walk.tenant_id
        ), 0) AS running_count
      FROM tenant_walk AS walk
      LEFT JOIN policy ON policy.tenant_id = walk.tenant_id
      WHERE walk.tenant_id IS NOT NULL
        AND COALESCE(policy.jobs_enabled, true)
    ),
    ranked AS (
      SELECT
        top.id,
        top.tenant_rank,
        candidate.queue_weight
      FROM candidate_tenants AS candidate
      CROSS JOIN LATERAL (
        -- Backfill depth scales with weight; the whole batch is still capped by
        -- the claim limit, so an idle system is fully usable by one tenant.
        SELECT job.id, row_number() OVER () AS tenant_rank
        FROM execution_jobs AS job
        WHERE job.tenant_id = candidate.tenant_id
          AND job.status = 'pending'
          AND job.available_at <= clock_timestamp()
          AND job.kind IN (${sql.join(kinds)})
        ORDER BY job.priority DESC, job.created_at, job.id
        LIMIT GREATEST(1, ${args.limit} * candidate.queue_weight)
      ) AS top
      -- Never exceed the tenant's ceiling on simultaneously leased jobs.
      WHERE candidate.max_concurrent_jobs IS NULL
        OR candidate.running_count + top.tenant_rank <= candidate.max_concurrent_jobs
    ),
    eligible AS (
      SELECT id, tenant_rank, queue_weight
      FROM ranked
      -- Rank 1 for every tenant first (the fairness floor), then deeper ranks.
      ORDER BY tenant_rank, queue_weight DESC, id
      -- Over-select so rows lost to SKIP LOCKED do not shrink the batch.
      LIMIT ${args.limit * 4}
    )
    SELECT job.id
    FROM execution_jobs AS job
    JOIN eligible ON eligible.id = job.id
    WHERE job.status = 'pending'
    ORDER BY eligible.tenant_rank, eligible.queue_weight DESC, job.id
    LIMIT ${args.limit}
    FOR UPDATE OF job SKIP LOCKED
  `.execute(args.trx);
  return rows.rows.map((row) => row.id);
}

function escapeLike(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("%", "\\%")
    .replaceAll("_", "\\_");
}

function mapExecutionJob(row: ExecutionJobRow): ExecutionJob {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    workflowRunId: row.workflow_run_id,
    workflowStepAttemptId: row.workflow_step_attempt_id,
    kind: parseExecutionJobKind(row.kind),
    payload: row.payload,
    status: parseExecutionJobStatus(row.status),
    priority: row.priority,
    availableAt: row.available_at.toISOString(),
    attempt: row.attempt,
    maxAttempts: row.max_attempts,
    leasedBy: row.leased_by,
    leaseToken: row.lease_token,
    leaseGeneration: String(row.lease_generation),
    leaseExpiresAt: row.lease_expires_at?.toISOString() ?? null,
    dedupeKey: row.dedupe_key,
    lastError: row.last_error,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    completedAt: row.completed_at?.toISOString() ?? null,
    exhaustionHandledAt: row.exhaustion_handled_at?.toISOString() ?? null,
  };
}

function parseExecutionJobKind(value: string): ExecutionJobKind {
  if (
    value === "workflow_run" ||
    value === "durable_boundary" ||
    value === "durable_pause_timeout" ||
    value === "batch_source" ||
    value === "batch_item" ||
    value === "batch_step" ||
    value === "batch_sink"
  ) {
    return value;
  }
  throw new Error(`Unknown execution job kind: ${value}`);
}

function parseExecutionJobStatus(value: string): ExecutionJobStatus {
  if (
    value === "pending" ||
    value === "running" ||
    value === "completed" ||
    value === "failed" ||
    value === "canceled"
  ) {
    return value;
  }
  throw new Error(`Unknown execution job status: ${value}`);
}
