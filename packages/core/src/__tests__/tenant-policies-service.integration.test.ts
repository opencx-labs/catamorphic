import { createDatabase, migrateToLatest } from "@catamorphic/db";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { RateLimit } from "../services/rate-reservations-service.js";
import {
  TenantActiveRunLimitError,
  TenantPoliciesService,
} from "../services/tenant-policies-service.js";

const connectionString = process.env.DATABASE_URL ?? "";
const describeIf = connectionString ? describe : describe.skip;
const schema = `catamorphic_tenant_policies_${crypto
  .randomUUID()
  .replaceAll("-", "")}`;
const db = createDatabase({ connectionString, schema, poolSize: 8 });
const policies = new TenantPoliciesService(db);
const tenantId = crypto.randomUUID();
const projectId = crypto.randomUUID();
const artifactId = crypto.randomUUID();

const authorLimits: readonly RateLimit[] = [
  {
    key: { globalKey: "whatsapp" },
    capacity: 1_000,
    refillRatePerSecond: 100,
    cost: 5,
  },
];

describeIf("TenantPoliciesService integration", () => {
  beforeAll(async () => {
    await migrateToLatest({ db, schema });
    await db
      .insertInto("tenants")
      .values({ id: tenantId, name: "Policy test tenant" })
      .execute();
    await db
      .insertInto("projects")
      .values({ id: projectId, tenant_id: tenantId, name: "Policy project" })
      .execute();
    await db
      .insertInto("deployment_artifacts")
      .values({
        id: artifactId,
        project_id: projectId,
        commit_sha: "a".repeat(40),
        artifact_digest: "b".repeat(64),
        plugin_digest: "c".repeat(64),
        transform_version: "test",
        runtime_version: "test",
        status: "ready",
      })
      .execute();
  });

  beforeEach(async () => {
    await db.deleteFrom("workflow_runs").execute();
    await db.deleteFrom("tenant_execution_policies").execute();
  });

  afterAll(async () => {
    await sql.raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).execute(db);
    await db.destroy();
  });

  it("leaves an unconfigured tenant unconstrained", async () => {
    const policy = await policies.get(tenantId);

    expect(policy).toMatchObject({
      queueWeight: 1,
      jobsEnabled: true,
      rateLimitOverrides: {},
    });
    expect(policy.maxConcurrentJobs).toBeUndefined();
    expect(policy.maxActiveRuns).toBeUndefined();
    await expect(
      policies.applyRateOverrides({ tenantId, limits: authorLimits }),
    ).resolves.toEqual(authorLimits);
  });

  it("tightens an author's declared bucket but never loosens it", async () => {
    await policies.upsert({
      tenantId,
      rateLimitOverrides: {
        whatsapp: { capacity: 50, refillRatePerSecond: 500 },
      },
    });

    const [limit] = await policies.applyRateOverrides({
      tenantId,
      limits: authorLimits,
    });

    expect(limit?.capacity).toBe(50);
    // The override asked for a higher refill than the author declared the
    // provider accepts, so the author's value wins.
    expect(limit?.refillRatePerSecond).toBe(100);
  });

  it("keeps a clamped bucket able to admit one unit of declared work", async () => {
    await policies.upsert({
      tenantId,
      rateLimitOverrides: { whatsapp: { capacity: 1 } },
    });

    const [limit] = await policies.applyRateOverrides({
      tenantId,
      limits: authorLimits,
    });

    // Clamping below cost would deadlock the boundary forever.
    expect(limit?.capacity).toBe(5);
  });

  it("merges partial updates instead of resetting the policy", async () => {
    await policies.upsert({ tenantId, maxConcurrentJobs: 4, queueWeight: 3 });
    await policies.upsert({ tenantId, jobsEnabled: false });

    expect(await policies.get(tenantId)).toMatchObject({
      maxConcurrentJobs: 4,
      queueWeight: 3,
      jobsEnabled: false,
    });
  });

  it("enforces the active run ceiling inside the caller's transaction", async () => {
    await policies.upsert({ tenantId, maxActiveRuns: 1 });
    const assertCapacity = () =>
      db
        .transaction()
        .execute((trx) => policies.assertActiveRunCapacity({ trx, tenantId }));

    await expect(assertCapacity()).resolves.toBeUndefined();

    await db
      .insertInto("workflow_runs")
      .values({
        id: crypto.randomUUID(),
        project_id: projectId,
        workflow_name: "campaign",
        mode: "production",
        provenance: sql`${JSON.stringify({ commitSha: "a".repeat(40) })}::jsonb`,
        deployment_artifact_id: artifactId,
        status: "running",
      })
      .execute();

    await expect(assertCapacity()).rejects.toBeInstanceOf(
      TenantActiveRunLimitError,
    );
  });

  it("rejects nonsensical policy values", async () => {
    await expect(
      policies.upsert({ tenantId, maxConcurrentJobs: 0 }),
    ).rejects.toThrow("must be a positive integer");
    await expect(
      policies.upsert({ tenantId, queueWeight: 5_000 }),
    ).rejects.toThrow("must not exceed 1000");
    await expect(
      policies.upsert({
        tenantId,
        rateLimitOverrides: { whatsapp: { capacity: -1 } },
      }),
    ).rejects.toThrow("must be a positive finite number");
  });
});
