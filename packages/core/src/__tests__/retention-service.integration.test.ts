import { createDatabase, migrateToLatest } from "@catamorphic/db";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ExecutionJobsService } from "../services/execution-jobs-service.js";
import { RetentionService } from "../services/retention-service.js";
import { TenantPoliciesService } from "../services/tenant-policies-service.js";

const connectionString = process.env.DATABASE_URL ?? "";
const describeIf = connectionString ? describe : describe.skip;
const schema = `catamorphic_retention_${crypto
  .randomUUID()
  .replaceAll("-", "")}`;
const db = createDatabase({ connectionString, schema });
const jobs = new ExecutionJobsService(db);
const policies = new TenantPoliciesService(db);

const tenantId = crypto.randomUUID();
const projectId = crypto.randomUUID();

async function createAttempt(args: {
  runId: string;
  status: string;
}): Promise<string> {
  const attemptId = crypto.randomUUID();
  const terminal = ["completed", "failed", "canceled"].includes(args.status);
  await sql`
    INSERT INTO workflow_step_attempts
      (id, run_id, step_index, step_node_id, executor, attempt, status, completed_at)
    VALUES (
      ${attemptId}::uuid, ${args.runId}::uuid, 0, 'n1', 'boundary', 1, ${args.status},
      ${terminal ? sql`clock_timestamp()` : sql`NULL`}
    )
  `.execute(db);
  return attemptId;
}

async function createRun(args: {
  status: string;
  completedDaysAgo?: number;
  parentRunId?: string;
}): Promise<string> {
  const runId = crypto.randomUUID();
  // A child run is linked to the step attempt that spawned it, which the
  // schema requires to be set together with parent_run_id.
  const parentAttemptId = args.parentRunId
    ? await createAttempt({ runId: args.parentRunId, status: "running" })
    : undefined;
  await db
    .insertInto("workflow_runs")
    .values({
      id: runId,
      project_id: projectId,
      workflow_name: "retained",
      mode: "test",
      provenance: sql`'{}'::jsonb`,
      status: args.status,
      ...(args.parentRunId && parentAttemptId
        ? {
            parent_run_id: args.parentRunId,
            parent_workflow_step_attempt_id: parentAttemptId,
          }
        : {}),
      ...(args.completedDaysAgo === undefined
        ? {}
        : {
            completed_at: sql<Date>`clock_timestamp() - (${args.completedDaysAgo} * interval '1 day')`,
          }),
    })
    .execute();
  return runId;
}

async function runExists(runId: string): Promise<boolean> {
  const row = await db
    .selectFrom("workflow_runs")
    .where("id", "=", runId)
    .select("id")
    .executeTakeFirst();
  return row !== undefined;
}

describeIf("run retention", () => {
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

  beforeEach(async () => {
    await db.deleteFrom("workflow_runs").execute();
    await db.deleteFrom("tenant_execution_policies").execute();
  });

  afterAll(async () => {
    await sql.raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).execute(db);
    await db.destroy();
  });

  it("purges terminal runs past the window and keeps the rest", async () => {
    const old = await createRun({ status: "completed", completedDaysAgo: 120 });
    const recent = await createRun({
      status: "completed",
      completedDaysAgo: 3,
    });
    const running = await createRun({ status: "running" });

    const retention = new RetentionService(db);
    const result = await retention.purgeExpiredRuns();

    expect(result.purgedRuns).toBe(1);
    expect(await runExists(old)).toBe(false);
    expect(await runExists(recent)).toBe(true);
    expect(await runExists(running)).toBe(true);
  });

  it("cascades to everything hanging off a purged run", async () => {
    const runId = await createRun({
      status: "completed",
      completedDaysAgo: 120,
    });
    await createAttempt({ runId, status: "completed" });
    await jobs.enqueue({
      tenantId,
      workflowRunId: runId,
      kind: "workflow_run",
      payload: {},
    });
    await sql`
      INSERT INTO workflow_run_events (run_id, invocation_id, sequence, type)
      VALUES (${runId}::uuid, 'inv', 0, 'started')
    `.execute(db);

    await new RetentionService(db).purgeExpiredRuns();

    const counts = await sql<{
      jobs: string;
      events: string;
      attempts: string;
    }>`
      SELECT
        (SELECT count(*) FROM execution_jobs WHERE workflow_run_id = ${runId}::uuid) AS jobs,
        (SELECT count(*) FROM workflow_run_events WHERE run_id = ${runId}::uuid) AS events,
        (SELECT count(*) FROM workflow_step_attempts WHERE run_id = ${runId}::uuid) AS attempts
    `.execute(db);
    expect(counts.rows[0]).toEqual({ jobs: "0", events: "0", attempts: "0" });
  });

  it("keeps a finished parent whose child is still running", async () => {
    const parent = await createRun({
      status: "failed",
      completedDaysAgo: 120,
    });
    const child = await createRun({ status: "running", parentRunId: parent });

    const result = await new RetentionService(db).purgeExpiredRuns();

    // Cascading here would delete in-flight work the child is still doing.
    expect(result.purgedRuns).toBe(0);
    expect(await runExists(parent)).toBe(true);
    expect(await runExists(child)).toBe(true);
  });

  it("keeps a tree whose live run is deeper than a direct child", async () => {
    // Every ancestor is terminal and aged out; only the leaf is still running.
    // A guard that checked direct children alone would find the root's own
    // child terminal, purge the root, and cascade through it onto the leaf.
    const root = await createRun({
      status: "completed",
      completedDaysAgo: 120,
    });
    const middle = await createRun({
      status: "completed",
      completedDaysAgo: 120,
      parentRunId: root,
    });
    const leaf = await createRun({ status: "running", parentRunId: middle });

    const result = await new RetentionService(db).purgeExpiredRuns();

    expect(result.purgedRuns).toBe(0);
    expect(await runExists(root)).toBe(true);
    expect(await runExists(middle)).toBe(true);
    expect(await runExists(leaf)).toBe(true);
  });

  it("purges a finished parent once its children have settled", async () => {
    const parent = await createRun({
      status: "completed",
      completedDaysAgo: 120,
    });
    const child = await createRun({
      status: "completed",
      completedDaysAgo: 120,
      parentRunId: parent,
    });

    const result = await new RetentionService(db).purgeExpiredRuns();

    // The child goes with the parent's cascade, so only the root is counted.
    expect(result.purgedRuns).toBe(1);
    expect(await runExists(parent)).toBe(false);
    expect(await runExists(child)).toBe(false);
  });

  it("lets a tenant policy override the installation window", async () => {
    const runId = await createRun({
      status: "completed",
      completedDaysAgo: 120,
    });
    await policies.upsert({ tenantId, retentionDays: 365 });

    const retention = new RetentionService(db);
    expect((await retention.purgeExpiredRuns()).purgedRuns).toBe(0);
    expect(await runExists(runId)).toBe(true);

    await policies.upsert({ tenantId, retentionDays: 30 });
    expect((await retention.purgeExpiredRuns()).purgedRuns).toBe(1);
    expect(await runExists(runId)).toBe(false);
  });

  it("keeps everything when retention is disabled", async () => {
    const runId = await createRun({
      status: "completed",
      completedDaysAgo: 3_650,
    });

    const retention = new RetentionService(db, { enabled: false });
    expect((await retention.purgeExpiredRuns()).purgedRuns).toBe(0);
    expect(await runExists(runId)).toBe(true);
  });

  it("bounds each sweep so a large backlog drains over several passes", async () => {
    for (let index = 0; index < 5; index += 1) {
      await createRun({ status: "completed", completedDaysAgo: 120 });
    }

    const retention = new RetentionService(db, { purgeBatchSize: 2 });
    expect((await retention.purgeExpiredRuns()).purgedRuns).toBe(2);
    expect((await retention.purgeExpiredRuns()).purgedRuns).toBe(2);
    expect((await retention.purgeExpiredRuns()).purgedRuns).toBe(1);
    expect((await retention.purgeExpiredRuns()).purgedRuns).toBe(0);
  });

  it("rejects a window that would purge immediately", () => {
    expect(() => new RetentionService(db, { runRetentionDays: 0 })).toThrow(
      /positive integer/,
    );
    expect(() => new RetentionService(db, { purgeBatchSize: -1 })).toThrow(
      /positive integer/,
    );
  });
});
