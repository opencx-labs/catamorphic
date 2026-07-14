import type { DB, Json } from "@catamorphic/db";
import { getTracer, withSpan } from "@catamorphic/otel";
import type { Kysely, Selectable, Transaction } from "kysely";

export type ExecutionJobKind =
  | "workflow_run"
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
  kind: ExecutionJobKind;
  payload: Json;
  status: ExecutionJobStatus;
  priority: number;
  availableAt: string;
  attempt: number;
  maxAttempts: number;
  leasedBy: string | null;
  leaseExpiresAt: string | null;
  dedupeKey: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
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
            available_at: args.availableAt ?? new Date(),
            max_attempts: args.maxAttempts ?? 5,
            dedupe_key: args.dedupeKey ?? null,
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
    const leaseExpiresAt = new Date(
      Date.now() + (args.leaseSeconds ?? 60) * 1_000,
    );

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
            .where("available_at", "<=", new Date())
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
              lease_expires_at: leaseExpiresAt,
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
    leaseSeconds?: number;
  }): Promise<boolean> {
    const result = await this.db
      .updateTable("execution_jobs")
      .set({
        lease_expires_at: new Date(
          Date.now() + (args.leaseSeconds ?? 60) * 1_000,
        ),
        updated_at: new Date(),
      })
      .where("id", "=", args.jobId)
      .where("status", "=", "running")
      .where("leased_by", "=", args.workerId)
      .executeTakeFirst();
    return Number(result.numUpdatedRows) === 1;
  }

  async complete(args: { jobId: string; workerId: string }): Promise<boolean> {
    const now = new Date();
    const result = await this.db
      .updateTable("execution_jobs")
      .set({
        status: "completed",
        leased_by: null,
        lease_expires_at: null,
        completed_at: now,
        updated_at: now,
      })
      .where("id", "=", args.jobId)
      .where("status", "=", "running")
      .where("leased_by", "=", args.workerId)
      .executeTakeFirst();
    return Number(result.numUpdatedRows) === 1;
  }

  async fail(args: {
    jobId: string;
    workerId: string;
    error: string;
    retryAt?: Date;
  }): Promise<ExecutionJobStatus | null> {
    return this.db.transaction().execute(async (trx) => {
      const row = await trx
        .selectFrom("execution_jobs")
        .where("id", "=", args.jobId)
        .where("status", "=", "running")
        .where("leased_by", "=", args.workerId)
        .select(["attempt", "max_attempts"])
        .forUpdate()
        .executeTakeFirst();
      if (!row) return null;

      const retry = row.attempt < row.max_attempts;
      const status: ExecutionJobStatus = retry ? "pending" : "failed";
      await trx
        .updateTable("execution_jobs")
        .set({
          status,
          available_at: retry
            ? (args.retryAt ?? retryDate(row.attempt))
            : new Date(),
          leased_by: null,
          lease_expires_at: null,
          last_error: args.error,
          completed_at: retry ? null : new Date(),
          updated_at: new Date(),
        })
        .where("id", "=", args.jobId)
        .execute();
      return status;
    });
  }

  async release(args: {
    jobId: string;
    workerId: string;
    availableAt: Date;
  }): Promise<boolean> {
    const result = await this.db
      .updateTable("execution_jobs")
      .set((eb) => ({
        status: "pending",
        available_at: args.availableAt,
        leased_by: null,
        lease_expires_at: null,
        attempt: eb("attempt", "-", 1),
        updated_at: new Date(),
      }))
      .where("id", "=", args.jobId)
      .where("status", "=", "running")
      .where("leased_by", "=", args.workerId)
      .executeTakeFirst();
    return Number(result.numUpdatedRows) === 1;
  }

  async cancel(args: { jobId: string }): Promise<boolean> {
    const now = new Date();
    const result = await this.db
      .updateTable("execution_jobs")
      .set({
        status: "canceled",
        leased_by: null,
        lease_expires_at: null,
        completed_at: now,
        updated_at: now,
      })
      .where("id", "=", args.jobId)
      .where("status", "in", ["pending", "running"])
      .executeTakeFirst();
    return Number(result.numUpdatedRows) === 1;
  }

  async cancelByDedupeKey(args: {
    tenantId: string;
    dedupeKey: string;
  }): Promise<boolean> {
    const now = new Date();
    const result = await this.db
      .updateTable("execution_jobs")
      .set({
        status: "canceled",
        leased_by: null,
        lease_expires_at: null,
        completed_at: now,
        updated_at: now,
      })
      .where("tenant_id", "=", args.tenantId)
      .where("dedupe_key", "=", args.dedupeKey)
      .where("status", "in", ["pending", "running"])
      .executeTakeFirst();
    return Number(result.numUpdatedRows) === 1;
  }

  async cancelByDedupePrefix(args: {
    tenantId: string;
    dedupePrefix: string;
  }): Promise<number> {
    const now = new Date();
    const result = await this.db
      .updateTable("execution_jobs")
      .set({
        status: "canceled",
        leased_by: null,
        lease_expires_at: null,
        completed_at: now,
        updated_at: now,
      })
      .where("tenant_id", "=", args.tenantId)
      .where("dedupe_key", "like", `${escapeLike(args.dedupePrefix)}%`)
      .where("status", "in", ["pending", "running"])
      .executeTakeFirst();
    return Number(result.numUpdatedRows);
  }

  async makeAvailable(args: {
    tenantId: string;
    dedupeKey: string;
    availableAt?: Date;
  }): Promise<void> {
    const availableAt = args.availableAt ?? new Date();
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
        available_at: args.availableAt ?? new Date(),
        leased_by: null,
        lease_expires_at: null,
        last_error: null,
        completed_at: null,
        updated_at: new Date(),
      })
      .where("id", "=", args.jobId)
      .where("tenant_id", "=", args.tenantId)
      .where("status", "=", "failed")
      .executeTakeFirst();
    return Number(result.numUpdatedRows) === 1;
  }

  async requeueExpired(args: { limit?: number } = {}): Promise<number> {
    const expired = await this.db
      .selectFrom("execution_jobs")
      .where("status", "=", "running")
      .where("lease_expires_at", "<", new Date())
      .select("id")
      .orderBy("lease_expires_at", "asc")
      .limit(Math.max(1, Math.min(args.limit ?? 100, 1_000)))
      .execute();
    const ids = expired.map((row) => row.id);
    if (ids.length === 0) return 0;

    const result = await this.db
      .updateTable("execution_jobs")
      .set({
        status: "pending",
        leased_by: null,
        lease_expires_at: null,
        available_at: new Date(),
        updated_at: new Date(),
      })
      .where("id", "in", ids)
      .where("status", "=", "running")
      .executeTakeFirst();
    return Number(result.numUpdatedRows);
  }
}

function retryDate(attempt: number): Date {
  const delaySeconds = Math.min(300, 2 ** Math.min(attempt, 8));
  return new Date(Date.now() + delaySeconds * 1_000);
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
    .where("available_at", "<=", new Date())
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
    kind: parseExecutionJobKind(row.kind),
    payload: row.payload,
    status: parseExecutionJobStatus(row.status),
    priority: row.priority,
    availableAt: row.available_at.toISOString(),
    attempt: row.attempt,
    maxAttempts: row.max_attempts,
    leasedBy: row.leased_by,
    leaseExpiresAt: row.lease_expires_at?.toISOString() ?? null,
    dedupeKey: row.dedupe_key,
    lastError: row.last_error,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    completedAt: row.completed_at?.toISOString() ?? null,
  };
}

function parseExecutionJobKind(value: string): ExecutionJobKind {
  if (
    value === "workflow_run" ||
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
