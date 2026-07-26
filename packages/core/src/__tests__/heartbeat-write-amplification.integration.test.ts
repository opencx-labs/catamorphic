import { createDatabase, migrateToLatest } from "@catamorphic/db";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ExecutionJobsService } from "../services/execution-jobs-service.js";

const connectionString = process.env.DATABASE_URL ?? "";
const describeIf = connectionString ? describe : describe.skip;
const schema = `catamorphic_hot_${crypto.randomUUID().replaceAll("-", "")}`;
const db = createDatabase({ connectionString, schema });
const jobs = new ExecutionJobsService(db);

describeIf("heartbeat write amplification", () => {
  beforeAll(async () => {
    await migrateToLatest({ db, schema });
  }, 120_000);

  afterAll(async () => {
    await sql.raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).execute(db);
    await db.destroy();
  });

  it("keeps heartbeats HOT so they do not churn indexes", async () => {
    const tenantId = crypto.randomUUID();
    const projectId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    await db
      .insertInto("tenants")
      .values({ id: tenantId, name: "T" })
      .execute();
    await db
      .insertInto("projects")
      .values({ id: projectId, tenant_id: tenantId, name: "P" })
      .execute();
    await db
      .insertInto("workflow_runs")
      .values({
        id: runId,
        project_id: projectId,
        workflow_name: "w",
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
    const [claimed] = await jobs.claim({
      workerId: "w1",
      kinds: ["batch_item"],
      limit: 1,
    });
    expect(claimed).toBeDefined();
    if (!claimed) return;

    async function hotStats(): Promise<{ updates: number; hot: number }> {
      await sql`SELECT pg_stat_force_next_flush()`.execute(db);
      const result = await sql<{ n_tup_upd: string; n_tup_hot_upd: string }>`
        SELECT n_tup_upd, n_tup_hot_upd FROM pg_stat_user_tables
        WHERE relname = 'execution_jobs' AND schemaname = ${schema}
      `.execute(db);
      const row = result.rows[0];
      return {
        updates: Number(row?.n_tup_upd ?? 0),
        hot: Number(row?.n_tup_hot_upd ?? 0),
      };
    }

    // Leave free space on the page for the new row versions to live in.
    await sql`VACUUM ANALYZE execution_jobs`.execute(db);
    const before = await hotStats();
    const beats = 40;
    for (let index = 0; index < beats; index += 1) {
      await jobs.heartbeat({
        jobId: claimed.id,
        workerId: "w1",
        leaseToken: claimed.leaseToken ?? "",
        leaseGeneration: claimed.leaseGeneration,
        leaseSeconds: 600,
      });
    }
    const after = await hotStats();

    const updates = after.updates - before.updates;
    const hot = after.hot - before.hot;
    expect(updates).toBeGreaterThanOrEqual(beats);
    // Indexing any column a heartbeat writes makes every beat a non-HOT update,
    // leaving a dead tuple and an index entry per beat on the hottest table in
    // the system. Measured at 0% HOT before idx_execution_jobs_lease was
    // dropped, 100% after.
    expect(hot / updates).toBeGreaterThan(0.9);
  }, 120_000);
});
