import { createDatabase, migrateToLatest } from "@catamorphic/db";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ExecutionJobsService } from "../services/execution-jobs-service.js";
import { TenantPoliciesService } from "../services/tenant-policies-service.js";

const connectionString = process.env.DATABASE_URL ?? "";
const describeIf = connectionString ? describe : describe.skip;
const schema = `catamorphic_queue_fairness_${crypto
  .randomUUID()
  .replaceAll("-", "")}`;
const db = createDatabase({ connectionString, schema, poolSize: 8 });
const jobs = new ExecutionJobsService(db);
const policies = new TenantPoliciesService(db);

const busyTenant = crypto.randomUUID();
const quietTenant = crypto.randomUUID();
const cappedTenant = crypto.randomUUID();

const projectIds = new Map<string, string>();

// Jobs are FK-bound to a run, so each tenant needs one project and one run to
// hang its queue backlog off.
async function seedTenant(args: {
  tenantId: string;
  name: string;
}): Promise<void> {
  const projectId = crypto.randomUUID();
  await db
    .insertInto("projects")
    .values({
      id: projectId,
      tenant_id: args.tenantId,
      name: args.name,
    })
    .execute();
  projectIds.set(args.tenantId, projectId);
}

async function createRun(tenantId: string): Promise<string> {
  const runId = crypto.randomUUID();
  await db
    .insertInto("workflow_runs")
    .values({
      id: runId,
      project_id: projectIds.get(tenantId) ?? "",
      workflow_name: "queueFixture",
      provenance: sql`'{}'::jsonb`,
      status: "pending",
    })
    .execute();
  return runId;
}

async function enqueue(args: {
  tenantId: string;
  count: number;
  priority?: number;
}): Promise<void> {
  const runId = await createRun(args.tenantId);
  for (let index = 0; index < args.count; index += 1) {
    await jobs.enqueue({
      tenantId: args.tenantId,
      workflowRunId: runId,
      kind: "durable_boundary",
      payload: {},
      ...(args.priority === undefined ? {} : { priority: args.priority }),
    });
  }
}

describeIf("execution queue fairness", () => {
  beforeAll(async () => {
    await migrateToLatest({ db, schema });
    await db
      .insertInto("tenants")
      .values([
        { id: busyTenant, name: "Busy tenant" },
        { id: quietTenant, name: "Quiet tenant" },
        { id: cappedTenant, name: "Capped tenant" },
      ])
      .execute();
    await seedTenant({ tenantId: busyTenant, name: "Busy project" });
    await seedTenant({ tenantId: quietTenant, name: "Quiet project" });
    await seedTenant({ tenantId: cappedTenant, name: "Capped project" });
  });

  beforeEach(async () => {
    await db.deleteFrom("execution_jobs").execute();
    await db.deleteFrom("workflow_runs").execute();
    await db.deleteFrom("tenant_execution_policies").execute();
  });

  afterAll(async () => {
    await sql.raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).execute(db);
    await db.destroy();
  });

  it("lets one tenant use idle capacity instead of one job per poll", async () => {
    await enqueue({ tenantId: busyTenant, count: 50 });

    const claimed = await jobs.claim({
      workerId: "worker-1",
      kinds: ["durable_boundary"],
      limit: 20,
    });

    // The old one-per-tenant claim would have returned exactly 1 here, which is
    // what capped campaign throughput regardless of spare capacity.
    expect(claimed).toHaveLength(20);
    expect(new Set(claimed.map((job) => job.tenantId))).toEqual(
      new Set([busyTenant]),
    );
  });

  it("still gives every tenant a job before any tenant gets a second", async () => {
    await enqueue({ tenantId: busyTenant, count: 50 });
    await enqueue({ tenantId: quietTenant, count: 1 });

    const claimed = await jobs.claim({
      workerId: "worker-1",
      kinds: ["durable_boundary"],
      limit: 10,
    });

    expect(claimed).toHaveLength(10);
    expect(claimed.filter((job) => job.tenantId === quietTenant)).toHaveLength(
      1,
    );
    expect(claimed.filter((job) => job.tenantId === busyTenant)).toHaveLength(
      9,
    );
  });

  it("never leases more than a tenant's configured concurrency", async () => {
    await policies.upsert({ tenantId: cappedTenant, maxConcurrentJobs: 3 });
    await enqueue({ tenantId: cappedTenant, count: 25 });

    const first = await jobs.claim({
      workerId: "worker-1",
      kinds: ["durable_boundary"],
      limit: 20,
    });
    expect(first).toHaveLength(3);

    // Already-leased jobs count toward the ceiling, so a second worker gets none.
    const second = await jobs.claim({
      workerId: "worker-2",
      kinds: ["durable_boundary"],
      limit: 20,
    });
    expect(second).toHaveLength(0);

    await jobs.complete({
      jobId: first[0]?.id ?? "",
      workerId: "worker-1",
      leaseToken: first[0]?.leaseToken ?? "",
      leaseGeneration: first[0]?.leaseGeneration ?? "0",
    });

    const third = await jobs.claim({
      workerId: "worker-2",
      kinds: ["durable_boundary"],
      limit: 20,
    });
    expect(third).toHaveLength(1);
  });

  it("suspends claiming for a disabled tenant without touching others", async () => {
    await policies.upsert({ tenantId: busyTenant, jobsEnabled: false });
    await enqueue({ tenantId: busyTenant, count: 5 });
    await enqueue({ tenantId: quietTenant, count: 5 });

    const claimed = await jobs.claim({
      workerId: "worker-1",
      kinds: ["durable_boundary"],
      limit: 10,
    });

    expect(claimed.map((job) => job.tenantId)).toEqual(
      Array.from({ length: 5 }, () => quietTenant),
    );
    await policies.upsert({ tenantId: busyTenant, jobsEnabled: true });
  });

  it("claims higher priority work first within a tenant", async () => {
    await enqueue({ tenantId: quietTenant, count: 3, priority: 0 });
    await enqueue({ tenantId: quietTenant, count: 2, priority: 100 });

    const claimed = await jobs.claim({
      workerId: "worker-1",
      kinds: ["durable_boundary"],
      limit: 2,
    });

    expect(claimed.map((job) => job.priority)).toEqual([100, 100]);
  });

  it("claims at a cost set by tenant count, not backlog depth", async () => {
    const runId = await createRun(busyTenant);
    async function seed(count: number): Promise<void> {
      await sql`
        INSERT INTO execution_jobs
          (tenant_id, workflow_run_id, kind, payload, status, available_at)
        SELECT ${busyTenant}::uuid, ${runId}::uuid, 'durable_boundary', '{}'::jsonb,
               'pending', clock_timestamp()
        FROM generate_series(1::bigint, ${count}::bigint)
      `.execute(db);
      await sql`ANALYZE execution_jobs`.execute(db);
    }

    async function medianClaimMs(): Promise<number> {
      const samples: number[] = [];
      for (let index = 0; index < 5; index += 1) {
        const startedAt = performance.now();
        await db
          .transaction()
          .execute((trx) =>
            sql`SELECT id FROM execution_jobs WHERE status = 'pending' LIMIT 1`.execute(
              trx,
            ),
          );
        const baseline = performance.now() - startedAt;
        const claimStartedAt = performance.now();
        const claimed = await jobs.claim({
          workerId: `probe-${index}`,
          kinds: ["durable_boundary"],
          limit: 20,
        });
        expect(claimed).toHaveLength(20);
        samples.push(performance.now() - claimStartedAt - baseline);
      }
      return samples.sort((a, b) => a - b)[2] ?? 0;
    }

    await seed(2_000);
    const shallow = await medianClaimMs();
    await seed(40_000);
    const deep = await medianClaimMs();

    // A whole-set ranking sorts every pending row per poll, so this ratio grows
    // linearly with the backlog — 20x the rows measured ~20x the latency before
    // the LATERAL rewrite. Bounded selection keeps it roughly flat; the margin
    // is wide so ordinary CI noise cannot trip it.
    expect(deep).toBeLessThan(Math.max(shallow, 1) * 8);
  }, 120_000);
});
