import crypto from "node:crypto";
import { type DB, DEFAULT_SCHEMA, migrateToLatest } from "@catamorphic/db";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { Kysely, PGliteDialect, WithSchemaPlugin } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Identity } from "../identity.js";
import {
  type ConnectionProvider,
  ConnectionProviderRegistry,
} from "../services/connection-providers.js";
import { ConnectionsService } from "../services/connections-service.js";
import { MemoryCredentialVault } from "../services/credential-vault.js";
import { ExecutionAllocationsService } from "../services/execution-allocations-service.js";
import { ExecutionJobsService } from "../services/execution-jobs-service.js";

const pglite = new PGlite({ extensions: { pgcrypto } });
const db = new Kysely<DB>({
  dialect: new PGliteDialect({ pglite }),
  plugins: [new WithSchemaPlugin(DEFAULT_SCHEMA)],
});
const tenantId = crypto.randomUUID();
const projectId = crypto.randomUUID();
const identity: Identity = {
  tenantId,
  externalUserId: "member",
  connectionScope: [
    {
      projectId,
      environment: "company",
      alias: "directory",
      capabilities: ["users.list"],
    },
  ],
};

let authorizationCount = 0;
const provider: ConnectionProvider = {
  kind: "fake",
  displayName: "Fake Directory",
  beginAuthorization: async ({ state }) => ({
    challenge: { kind: "url", url: `https://auth.test/?state=${state}` },
  }),
  completeAuthorization: async () => {
    authorizationCount += 1;
    return {
      material: new TextEncoder().encode(`token-${authorizationCount}`),
      capabilities: ["users.list"],
    };
  },
  invoke: async () => ({ ok: true }),
};

describe("connection action recovery", () => {
  const connections = new ConnectionsService(
    db,
    new MemoryCredentialVault(),
    new ConnectionProviderRegistry([provider]),
  );
  const allocations = new ExecutionAllocationsService(db);
  const jobs = new ExecutionJobsService(db);

  beforeAll(async () => {
    await migrateToLatest({ db, schema: DEFAULT_SCHEMA });
    await db
      .insertInto("tenants")
      .values({ id: tenantId, name: "Tenant" })
      .execute();
    await db
      .insertInto("projects")
      .values({ id: projectId, tenant_id: tenantId, name: "Brain" })
      .execute();
    await connections.bind({
      identity: { tenantId, externalUserId: "admin" },
      projectId,
      environment: "company",
      alias: "directory",
      providerKind: "fake",
      principalKinds: ["member"],
      capabilities: ["users.list"],
    });
  }, 120_000);

  afterAll(async () => {
    await db.destroy();
  });

  it("reauthorizes the same connection and wakes the same durable job", async () => {
    const first = await connections.beginAuthorization({
      identity,
      projectId,
      environment: "company",
      alias: "directory",
      redirectUri: "https://app.test/callback",
    });
    const connection = await connections.completeAuthorization({
      identity,
      state: first.authorizationId,
      callback: { code: "first" },
    });
    const [resolved] = await connections.resolve({
      identity,
      projectId,
      environment: "company",
      aliases: ["directory"],
    });
    const allocation = await allocations.create({
      identity,
      projectId,
      environmentName: "company",
      workloadKind: "workflow",
      rootWorkloadId: crypto.randomUUID(),
      policy: {
        binding: {
          id: "managed",
          label: "Managed",
          trust: "managed",
          isolation: "sandbox",
          workloads: ["workflow"],
          agentTopologies: [],
          capabilities: ["network.egress"],
          resources: {},
        },
        requirements: { workload: "workflow" },
        connections: [resolved!],
      },
    });
    const runId = crypto.randomUUID();
    const stepAttemptId = crypto.randomUUID();
    const jobId = crypto.randomUUID();
    const leaseToken = crypto.randomUUID();
    await db
      .insertInto("workflow_runs")
      .values({
        id: runId,
        project_id: projectId,
        workflow_name: "onboard",
        environment_name: "company",
        allocation_id: allocation.id,
        external_user_id: identity.externalUserId,
        provenance: {},
        input: {},
      })
      .execute();
    await db
      .insertInto("workflow_step_attempts")
      .values({
        id: stepAttemptId,
        run_id: runId,
        step_index: 0,
        step_node_id: "boundary-0",
        executor: "boundary",
        attempt: 1,
      })
      .execute();
    await db
      .insertInto("execution_jobs")
      .values({
        id: jobId,
        tenant_id: tenantId,
        workflow_run_id: runId,
        workflow_step_attempt_id: stepAttemptId,
        kind: "durable_boundary",
        payload: {},
        status: "running",
        attempt: 1,
        leased_by: "worker",
        lease_token: leaseToken,
        lease_generation: 1,
        heartbeat_at: new Date(),
        lease_expires_at: new Date(Date.now() + 60_000),
      })
      .execute();
    const requirementId = await connections.parkWorkflowRequirement({
      identity,
      projectId,
      workflowRunId: runId,
      workflowStepAttemptId: stepAttemptId,
      executionJobId: jobId,
      allocationId: allocation.id,
      alias: "directory",
      connectionId: connection.id,
    });

    const second = await connections.beginAuthorization({
      identity,
      projectId,
      environment: "company",
      alias: "directory",
      redirectUri: "https://app.test/callback",
    });
    const reauthorized = await connections.completeAuthorization({
      identity,
      state: second.authorizationId,
      callback: { code: "second" },
    });
    expect(reauthorized.id).toBe(connection.id);
    expect(reauthorized.revision).toBe(connection.revision + 1);
    expect(
      (
        await db
          .selectFrom("connection_action_requirements")
          .where("id", "=", requirementId)
          .select("status")
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe("resolved");

    await jobs.release({
      jobId,
      workerId: "worker",
      leaseToken,
      leaseGeneration: "1",
      availableAt: new Date(Date.now() + 60 * 60 * 1_000),
      parkedForConnectionRequirementId: requirementId,
    });
    const released = await db
      .selectFrom("execution_jobs")
      .where("id", "=", jobId)
      .select(["status", "available_at", "attempt"])
      .executeTakeFirstOrThrow();
    expect(released.status).toBe("pending");
    expect(released.attempt).toBe(0);
    expect(released.available_at.getTime()).toBeLessThanOrEqual(Date.now());
  });
});
