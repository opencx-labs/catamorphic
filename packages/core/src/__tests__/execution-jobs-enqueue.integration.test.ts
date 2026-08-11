import { createDatabase, migrateToLatest } from "@catamorphic/db";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ExecutionJobsService } from "../services/execution-jobs-service.js";

const connectionString = process.env.DATABASE_URL ?? "";
const describeIf = connectionString ? describe : describe.skip;
const schema = `catamorphic_enq_${crypto.randomUUID().replaceAll("-", "")}`;
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
      workflow_name: "enqueue",
      mode: "test",
      provenance: sql`'{}'::jsonb`,
      status: "running",
    })
    .execute();
  return runId;
}

describeIf("execution job enqueue dedupe", () => {
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

  it("revives a dedupe key whose previous job already finished", async () => {
    const runId = await createRun();
    const first = await jobs.enqueue({
      tenantId,
      workflowRunId: runId,
      kind: "batch_sink",
      payload: {},
      dedupeKey: "sink:start",
    });
    const [claimed] = await jobs.claim({
      workerId: "worker-1",
      kinds: ["batch_sink"],
      limit: 1,
    });
    expect(claimed?.id).toBe(first.id);
    await jobs.fail({
      jobId: first.id,
      workerId: "worker-1",
      leaseToken: claimed?.leaseToken ?? "",
      leaseGeneration: claimed?.leaseGeneration ?? "0",
      error: "sink runtime crashed",
      retryAt: new Date(),
    });
    await db
      .updateTable("execution_jobs")
      .set({ status: "failed", completed_at: new Date() })
      .where("id", "=", first.id)
      .execute();

    // The batch retries its sink. Reusing the key must produce runnable work:
    // leaving the terminal row untouched wedges the batch with no job to claim.
    const second = await jobs.enqueue({
      tenantId,
      workflowRunId: runId,
      kind: "batch_sink",
      payload: {},
      dedupeKey: "sink:start",
    });
    expect(second.status).toBe("pending");

    const [reclaimed] = await jobs.claim({
      workerId: "worker-2",
      kinds: ["batch_sink"],
      limit: 1,
    });
    expect(reclaimed?.id).toBe(second.id);
  });

  it("still collapses a duplicate enqueue while the job is live", async () => {
    const runId = await createRun();
    const first = await jobs.enqueue({
      tenantId,
      workflowRunId: runId,
      kind: "batch_item",
      payload: {},
      dedupeKey: "item:1",
    });
    const second = await jobs.enqueue({
      tenantId,
      workflowRunId: runId,
      kind: "batch_item",
      payload: {},
      dedupeKey: "item:1",
    });
    expect(second.id).toBe(first.id);

    const claimed = await jobs.claim({
      workerId: "worker-1",
      kinds: ["batch_item"],
      limit: 10,
    });
    expect(claimed).toHaveLength(1);
  });
});
