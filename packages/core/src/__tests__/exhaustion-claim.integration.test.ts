import { createDatabase, migrateToLatest } from "@catamorphic/db";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ExecutionJobsService } from "../services/execution-jobs-service.js";

const connectionString = process.env.DATABASE_URL ?? "";
const describeIf = connectionString ? describe : describe.skip;
const schema = `catamorphic_exh_${crypto.randomUUID().replaceAll("-", "")}`;
const db = createDatabase({ connectionString, schema });
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
      workflow_name: "exhaustion",
      mode: "test",
      provenance: sql`'{}'::jsonb`,
      status: "running",
    })
    .execute();
  return runId;
}

/** Enqueue a job and drive it to `failed` with attempts exhausted. */
async function createExhaustedJob(): Promise<string> {
  const runId = await createRun();
  const job = await jobs.enqueue({
    tenantId,
    workflowRunId: runId,
    kind: "batch_item",
    payload: {},
    maxAttempts: 1,
  });
  const [claimed] = await jobs.claim({
    workerId: "worker-exh",
    kinds: ["batch_item"],
    limit: 1,
  });
  expect(claimed?.id).toBe(job.id);
  if (!claimed) throw new Error("claim failed");
  const status = await jobs.fail({
    jobId: claimed.id,
    workerId: "worker-exh",
    leaseToken: claimed.leaseToken ?? "",
    leaseGeneration: claimed.leaseGeneration,
    error: "boom",
  });
  expect(status).toBe("failed");
  return job.id;
}

async function stampAge(jobId: string, seconds: number): Promise<void> {
  await sql`
    UPDATE execution_jobs
    SET exhaustion_handled_at =
      clock_timestamp() - make_interval(secs => ${seconds})
    WHERE id = ${jobId}
  `.execute(db);
}

describeIf("exhaustion claim lifecycle", () => {
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
    await sql.raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).execute(db);
    await db.destroy();
  });

  it("claims an exhausted job exactly once while the claim is fresh", async () => {
    const jobId = await createExhaustedJob();

    const first = await jobs.claimExhausted({ limit: 10 });
    expect(first.map((job) => job.id)).toContain(jobId);

    // The stamp is fresh, so a concurrent sweep must not see the job.
    const second = await jobs.claimExhausted({ limit: 10 });
    expect(second.map((job) => job.id)).not.toContain(jobId);
  });

  it("reclaims a stale claim whose handler never confirmed", async () => {
    const jobId = await createExhaustedJob();
    expect(
      (await jobs.claimExhausted({ limit: 10 })).map((job) => job.id),
    ).toContain(jobId);

    // Simulate the claimer crashing: the stamp ages past the claim interval
    // with no receipt written.
    await stampAge(jobId, 11 * 60);

    const reclaimed = await jobs.claimExhausted({ limit: 10 });
    expect(reclaimed.map((job) => job.id)).toContain(jobId);
  });

  it("never reclaims after the receipt is written, even with an old stamp", async () => {
    const jobId = await createExhaustedJob();
    expect(
      (await jobs.claimExhausted({ limit: 10 })).map((job) => job.id),
    ).toContain(jobId);
    await jobs.confirmExhaustionHandled({ jobId });
    await stampAge(jobId, 11 * 60);

    const swept = await jobs.claimExhausted({ limit: 10 });
    expect(swept.map((job) => job.id)).not.toContain(jobId);
  });

  it("releases a claim so the next sweep retries immediately", async () => {
    const jobId = await createExhaustedJob();
    expect(
      (await jobs.claimExhausted({ limit: 10 })).map((job) => job.id),
    ).toContain(jobId);

    // Handler failed: the claim is returned without waiting out the lease.
    await jobs.releaseExhaustionClaim({ jobId });

    const retried = await jobs.claimExhausted({ limit: 10 });
    expect(retried.map((job) => job.id)).toContain(jobId);
  });

  it("lets the inline path win only when no live claim exists", async () => {
    const jobId = await createExhaustedJob();

    expect(await jobs.claimExhaustionFor({ jobId })).toBe(true);
    // A sweep (or another inline claimer) cannot double-claim.
    expect(await jobs.claimExhaustionFor({ jobId })).toBe(false);

    // But an expired claim is up for grabs again.
    await stampAge(jobId, 11 * 60);
    expect(await jobs.claimExhaustionFor({ jobId })).toBe(true);

    // And a receipt closes it for good.
    await jobs.confirmExhaustionHandled({ jobId });
    await stampAge(jobId, 11 * 60);
    expect(await jobs.claimExhaustionFor({ jobId })).toBe(false);
  });

  it("clears the receipt when a redriven job fails again", async () => {
    const jobId = await createExhaustedJob();
    expect(await jobs.claimExhaustionFor({ jobId })).toBe(true);
    await jobs.confirmExhaustionHandled({ jobId });

    // Redrive resets the terminal state; the job runs and exhausts again.
    expect(await jobs.redrive({ tenantId, jobId })).toBe(true);
    const [claimed] = await jobs.claim({
      workerId: "worker-exh-2",
      kinds: ["batch_item"],
      limit: 10,
    });
    expect(claimed?.id).toBe(jobId);
    if (!claimed) return;
    await jobs.fail({
      jobId,
      workerId: "worker-exh-2",
      leaseToken: claimed.leaseToken ?? "",
      leaseGeneration: claimed.leaseGeneration,
      error: "boom again",
    });

    // The second exhaustion must be handleable: receipt was reset by redrive.
    expect(await jobs.claimExhaustionFor({ jobId })).toBe(true);
  });
});
