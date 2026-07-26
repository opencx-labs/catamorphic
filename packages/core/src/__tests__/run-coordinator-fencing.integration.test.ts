import { createDatabase, migrateToLatest } from "@catamorphic/db";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ExecutionJobsService } from "../services/execution-jobs-service.js";
import { ownsJob } from "../services/run-coordinator.js";

const connectionString = process.env.DATABASE_URL ?? "";
const describeIf = connectionString ? describe : describe.skip;
const schema = `catamorphic_fence_${crypto.randomUUID().replaceAll("-", "")}`;
const db = createDatabase({ connectionString, schema });
const jobs = new ExecutionJobsService(db);

const tenantId = crypto.randomUUID();
const projectId = crypto.randomUUID();

describeIf("execution job lease fencing", () => {
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

  it("refuses a worker whose lease was reclaimed while it was still running", async () => {
    const runId = crypto.randomUUID();
    await db
      .insertInto("workflow_runs")
      .values({
        id: runId,
        project_id: projectId,
        workflow_name: "fenced",
        mode: "test",
        provenance: sql`'{}'::jsonb`,
        status: "running",
      })
      .execute();
    await jobs.enqueue({
      tenantId,
      workflowRunId: runId,
      kind: "batch_item",
      payload: {},
    });

    const [stale] = await jobs.claim({
      workerId: "worker-slow",
      kinds: ["batch_item"],
      limit: 1,
    });
    expect(stale).toBeDefined();
    if (!stale) return;

    // The slow worker stalls past its lease; the reaper hands the job on.
    await db
      .updateTable("execution_jobs")
      .set({
        lease_expires_at: sql<Date>`clock_timestamp() - interval '1 second'`,
      })
      .where("id", "=", stale.id)
      .execute();
    await jobs.requeueExpired({ limit: 10 });
    const [fresh] = await jobs.claim({
      workerId: "worker-fresh",
      kinds: ["batch_item"],
      limit: 1,
    });
    expect(fresh?.id).toBe(stale.id);

    // The stale worker now finishes and tries to act on the run. Without the
    // fence its failStep would cancel every job for the step — including the
    // healthy work the new owner is doing.
    const staleOwns = await db
      .transaction()
      .execute((trx) => ownsJob({ trx, job: stale }));
    expect(staleOwns).toBe(false);

    const freshOwns = await db
      .transaction()
      .execute((trx) => ownsJob({ trx, job: fresh ?? stale }));
    expect(freshOwns).toBe(true);
  });
});
