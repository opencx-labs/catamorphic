import { createDatabase, migrateToLatest } from "@catamorphic/db";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ExecutionJobsService,
  MAX_LEASE_EXPIRIES,
} from "../services/execution-jobs-service.js";

/**
 * Lease expiry is attempt-neutral (laptop-grade durability).
 *
 * On a desktop host the common lease death is the machine sleeping or powering
 * off mid-step, not the handler failing. Expiries therefore refund the attempt
 * their claim consumed and count against their own generous cap instead, so
 * repeated lid-closes during one long step can never exhaust a run — while a
 * handler that reliably kills its process still terminates at the cap.
 */

const connectionString = process.env.DATABASE_URL ?? "";
const describeIf = connectionString ? describe : describe.skip;
const schema = `catamorphic_lease_${crypto.randomUUID().replaceAll("-", "")}`;
const db = createDatabase({ connectionString, schema, poolSize: 8 });
const jobs = new ExecutionJobsService(db);

const tenantId = crypto.randomUUID();
const projectId = crypto.randomUUID();

async function createRun(): Promise<string> {
  const runId = crypto.randomUUID();
  await db
    .insertInto("workflow_runs")
    .values({
      id: runId,
      project_id: projectId,
      workflow_name: "lease-expiry",
      provenance: sql`'{}'::jsonb`,
      status: "running",
    })
    .execute();
  return runId;
}

/** Claim a specific job so parallel tests in this file never cross-claim. */
async function claimOne(workerId: string, jobId: string) {
  const claimed = await jobs.claimById({ jobId, workerId });
  if (!claimed) throw new Error(`job ${jobId} was not claimable`);
  return claimed;
}

/** Backdate the lease so the maintenance sweep sees it as expired. */
async function expireLease(jobId: string): Promise<void> {
  await sql`
    UPDATE execution_jobs
    SET lease_expires_at = clock_timestamp() - interval '1 second'
    WHERE id = ${jobId}
  `.execute(db);
}

async function readJob(jobId: string) {
  return db
    .selectFrom("execution_jobs")
    .selectAll()
    .where("id", "=", jobId)
    .executeTakeFirstOrThrow();
}

describeIf("lease expiry attempt neutrality", () => {
  beforeAll(async () => {
    await migrateToLatest({ db, schema });
    await db
      .insertInto("tenants")
      .values({ id: tenantId, name: "T" })
      .execute();
    await db
      .insertInto("projects")
      .values({ id: projectId, tenant_id: tenantId, name: "P" })
      .execute();
  }, 120_000);

  afterAll(async () => {
    await sql`DROP SCHEMA IF EXISTS ${sql.id(schema)} CASCADE`.execute(db);
    await db.destroy();
  });

  it("refunds the attempt and counts the expiry on requeue", async () => {
    const runId = await createRun();
    const job = await jobs.enqueue({
      tenantId,
      workflowRunId: runId,
      kind: "batch_item",
      payload: {},
      maxAttempts: 5,
    });
    const claimed = await claimOne("worker-a", job.id);
    expect(claimed.attempt).toBe(1);

    await expireLease(job.id);
    expect(await jobs.requeueExpired({})).toBe(1);

    const row = await readJob(job.id);
    expect(row.status).toBe("pending");
    expect(row.attempt).toBe(0);
    expect(row.lease_expiries).toBe(1);
    expect(row.lease_token).toBeNull();

    // Still claimable: the crash consumed no retry budget.
    const reclaimed = await claimOne("worker-b", job.id);
    expect(reclaimed.attempt).toBe(1);
  });

  it("survives more expiries than max_attempts", async () => {
    const runId = await createRun();
    const job = await jobs.enqueue({
      tenantId,
      workflowRunId: runId,
      kind: "batch_item",
      payload: {},
      maxAttempts: 2,
    });
    for (let round = 0; round < 5; round += 1) {
      await claimOne(`worker-${round}`, job.id);
      await expireLease(job.id);
      expect(await jobs.requeueExpired({})).toBe(1);
    }
    const row = await readJob(job.id);
    expect(row.status).toBe("pending");
    expect(row.attempt).toBe(0);
    expect(row.lease_expiries).toBe(5);
  });

  it("fails the job at the expiry cap", async () => {
    const runId = await createRun();
    const job = await jobs.enqueue({
      tenantId,
      workflowRunId: runId,
      kind: "batch_item",
      payload: {},
    });
    await claimOne("worker-cap", job.id);
    await expireLease(job.id);
    await sql`
      UPDATE execution_jobs
      SET lease_expiries = ${MAX_LEASE_EXPIRIES - 1}
      WHERE id = ${job.id}
    `.execute(db);

    expect(await jobs.requeueExpired({})).toBe(1);
    const row = await readJob(job.id);
    expect(row.status).toBe("failed");
    expect(row.lease_expiries).toBe(MAX_LEASE_EXPIRIES);
    expect(row.last_error).toContain("lease expired");

    // The terminal handler path picks it up like any exhausted job.
    const exhausted = await jobs.claimExhausted({ limit: 10 });
    expect(exhausted.map((entry) => entry.id)).toContain(job.id);
  });

  it("still charges attempts for genuine handler failures", async () => {
    const runId = await createRun();
    const job = await jobs.enqueue({
      tenantId,
      workflowRunId: runId,
      kind: "batch_item",
      payload: {},
      maxAttempts: 2,
    });
    for (let round = 0; round < 2; round += 1) {
      const claimed = await claimOne(`worker-fail-${round}`, job.id);
      const status = await jobs.fail({
        jobId: claimed.id,
        workerId: `worker-fail-${round}`,
        leaseToken: claimed.leaseToken ?? "",
        leaseGeneration: claimed.leaseGeneration,
        error: "boom",
        // Host and database clocks can differ slightly (notably when Postgres
        // runs in Docker), so make the retry unambiguously due.
        retryAt: new Date(0),
      });
      expect(status).toBe(round === 0 ? "pending" : "failed");
    }
    const row = await readJob(job.id);
    expect(row.status).toBe("failed");
    expect(row.attempt).toBe(2);
  });
});
