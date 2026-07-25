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
              .doUpdateSet({
                updated_at: new Date(),
              }),
          )
          .returningAll()
          .executeTakeFirstOrThrow();
        span.setAttribute("catamorphic.queue.job.id", row.id);
        return mapExecutionJob(row);
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
          const tenants = await trx
            .selectFrom("execution_jobs")
            .where("status", "=", "pending")
            .where("available_at", "<=", sql<Date>`clock_timestamp()`)
            .where("kind", "in", [...args.kinds])
            .select("tenant_id")
            .select((eb) => eb.fn.min("created_at").as("oldest_job_at"))
            .groupBy("tenant_id")
            .orderBy("oldest_job_at", "asc")
            .limit(limit)
            .execute();
          const ids = await claimOnePerTenant({
            trx,
            tenantIds: tenants.map((row) => row.tenant_id),
            kinds: args.kinds,
          });
          if (ids.length === 0) {
            span.setAttribute("catamorphic.queue.claimed_count", 0);
            span.setAttribute("catamorphic.queue.tenant_count", tenants.length);
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
          span.setAttribute("catamorphic.queue.tenant_count", tenants.length);
          return rows.map(mapExecutionJob);
        }),
    );
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
  }): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      const result = await trx
        .updateTable("execution_jobs")
        .set((eb) => ({
          status: "pending",
          available_at: args.availableAt,
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

  async listUnhandledExhausted(args: {
    limit?: number;
  }): Promise<ExecutionJob[]> {
    const rows = await this.db
      .selectFrom("execution_jobs")
      .where("status", "=", "failed")
      .where("exhaustion_handled_at", "is", null)
      .selectAll()
      .orderBy("completed_at", "asc")
      .limit(Math.max(1, Math.min(args.limit ?? 100, 1_000)))
      .execute();
    return rows.map(mapExecutionJob);
  }

  async markExhaustionHandled(args: { jobId: string }): Promise<boolean> {
    const result = await this.db
      .updateTable("execution_jobs")
      .set({
        exhaustion_handled_at: sql<Date>`clock_timestamp()`,
        updated_at: sql<Date>`clock_timestamp()`,
      })
      .where("id", "=", args.jobId)
      .where("status", "=", "failed")
      .where("exhaustion_handled_at", "is", null)
      .executeTakeFirst();
    return Number(result.numUpdatedRows) === 1;
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

async function claimOnePerTenant(args: {
  trx: Transaction<DB>;
  tenantIds: readonly string[];
  kinds: readonly ExecutionJobKind[];
  index?: number;
}): Promise<string[]> {
  const index = args.index ?? 0;
  const tenantId = args.tenantIds[index];
  if (!tenantId) return [];
  const job = await args.trx
    .selectFrom("execution_jobs")
    .where("tenant_id", "=", tenantId)
    .where("status", "=", "pending")
    .where("available_at", "<=", sql<Date>`clock_timestamp()`)
    .where("kind", "in", [...args.kinds])
    .select("id")
    .orderBy("priority", "desc")
    .orderBy("created_at", "asc")
    .forUpdate()
    .skipLocked()
    .limit(1)
    .executeTakeFirst();
  const remaining = await claimOnePerTenant({
    ...args,
    index: index + 1,
  });
  return job ? [job.id, ...remaining] : remaining;
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
