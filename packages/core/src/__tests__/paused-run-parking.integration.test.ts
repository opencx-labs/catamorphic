import { createDatabase, migrateToLatest } from "@catamorphic/db";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ExecutionJobsService } from "../services/execution-jobs-service.js";

const connectionString = process.env.DATABASE_URL ?? "";
const describeIf = connectionString ? describe : describe.skip;
const schema = `catamorphic_parking_${crypto.randomUUID().replaceAll("-", "")}`;
const db = createDatabase({ connectionString, schema, poolSize: 8 });
const jobs = new ExecutionJobsService(db);

const tenantId = crypto.randomUUID();
const projectId = crypto.randomUUID();

async function createRun(status: string): Promise<string> {
  const runId = crypto.randomUUID();
  await db
    .insertInto("workflow_runs")
    .values({
      id: runId,
      project_id: projectId,
      workflow_name: "parked",
      provenance: sql`'{}'::jsonb`,
      status,
    })
    .execute();
  return runId;
}

describeIf("paused run job parking", () => {
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

  beforeEach(async () => {
    // Claims and parked jobs deliberately remain unfinished in these tests.
    // Clear them so an expired lease from one case cannot be claimed by the
    // next sequential case under a slower, heavily loaded CI run.
    await db.deleteFrom("execution_jobs").execute();
    await db.deleteFrom("workflow_runs").execute();
  });

  it("stops a parked job from being reclaimed on the next poll", async () => {
    const runId = await createRun("paused");
    const job = await jobs.enqueue({
      tenantId,
      workflowRunId: runId,
      kind: "batch_item",
      payload: {},
    });
    const [claimed] = await jobs.claim({
      workerId: "worker-1",
      kinds: ["batch_item"],
      limit: 5,
    });
    expect(claimed?.id).toBe(job.id);
    if (!claimed) return;

    // The handler defers a paused run by parking the job an hour out.
    await jobs.release({
      jobId: claimed.id,
      workerId: "worker-1",
      leaseToken: claimed.leaseToken ?? "",
      leaseGeneration: claimed.leaseGeneration,
      availableAt: new Date(Date.now() + 60 * 60 * 1_000),
    });

    // A 100ms retry would hand the same job straight back, spinning forever.
    const next = await jobs.claim({
      workerId: "worker-1",
      kinds: ["batch_item"],
      limit: 5,
    });
    expect(next).toHaveLength(0);
  });

  it("makes a run's parked jobs claimable again", async () => {
    const runId = await createRun("paused");
    const other = await createRun("paused");
    for (let index = 0; index < 3; index += 1) {
      const job = await jobs.enqueue({
        tenantId,
        workflowRunId: runId,
        kind: "batch_item",
        payload: {},
        dedupeKey: `parked:${index}`,
      });
      await db
        .updateTable("execution_jobs")
        .set({
          available_at: sql<Date>`clock_timestamp() + interval '1 hour'`,
        })
        .where("id", "=", job.id)
        .execute();
    }
    const untouched = await jobs.enqueue({
      tenantId,
      workflowRunId: other,
      kind: "batch_item",
      payload: {},
      dedupeKey: "other:parked",
    });
    await db
      .updateTable("execution_jobs")
      .set({ available_at: sql<Date>`clock_timestamp() + interval '1 hour'` })
      .where("id", "=", untouched.id)
      .execute();

    expect(await jobs.makeRunAvailable({ runId })).toBe(3);

    const claimed = await jobs.claim({
      workerId: "worker-2",
      kinds: ["batch_item"],
      limit: 10,
    });
    // Only the woken run's jobs come back; the other run stays parked.
    expect(claimed).toHaveLength(3);
    expect(claimed.every((job) => job.workflowRunId === runId)).toBe(true);
  });

  it("wakes a parked release when the run resumed mid-flight", async () => {
    const runId = await createRun("paused");
    const job = await jobs.enqueue({
      tenantId,
      workflowRunId: runId,
      kind: "batch_item",
      payload: {},
    });
    const [claimed] = await jobs.claim({
      workerId: "worker-3",
      kinds: ["batch_item"],
      limit: 5,
    });
    expect(claimed?.id).toBe(job.id);
    if (!claimed) return;

    // The run resumes while the job is still leased: the resume's wake only
    // reaches pending jobs, so the release must notice and not park.
    await db
      .updateTable("workflow_runs")
      .set({ status: "running" })
      .where("id", "=", runId)
      .execute();
    await jobs.release({
      jobId: claimed.id,
      workerId: "worker-3",
      leaseToken: claimed.leaseToken ?? "",
      leaseGeneration: claimed.leaseGeneration,
      availableAt: new Date(Date.now() + 60 * 60 * 1_000),
      parkedForPausedRunId: runId,
    });

    const next = await jobs.claim({
      workerId: "worker-3",
      kinds: ["batch_item"],
      limit: 5,
    });
    expect(next.map((row) => row.id)).toEqual([job.id]);
  });

  it("keeps a parked release parked while the run stays paused", async () => {
    const runId = await createRun("paused");
    const job = await jobs.enqueue({
      tenantId,
      workflowRunId: runId,
      kind: "batch_item",
      payload: {},
    });
    const [claimed] = await jobs.claim({
      workerId: "worker-4",
      kinds: ["batch_item"],
      limit: 5,
    });
    expect(claimed?.id).toBe(job.id);
    if (!claimed) return;

    await jobs.release({
      jobId: claimed.id,
      workerId: "worker-4",
      leaseToken: claimed.leaseToken ?? "",
      leaseGeneration: claimed.leaseGeneration,
      availableAt: new Date(Date.now() + 60 * 60 * 1_000),
      parkedForPausedRunId: runId,
    });

    const next = await jobs.claim({
      workerId: "worker-4",
      kinds: ["batch_item"],
      limit: 5,
    });
    expect(next).toHaveLength(0);
  });

  it("leaves a job that is already due alone", async () => {
    const runId = await createRun("running");
    await jobs.enqueue({
      tenantId,
      workflowRunId: runId,
      kind: "durable_boundary",
      payload: {},
    });

    // Nothing is parked, so waking is a no-op rather than a reschedule.
    expect(await jobs.makeRunAvailable({ runId })).toBe(0);
  });
});
