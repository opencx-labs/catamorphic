import crypto from "node:crypto";
import { createDatabase, migrateToLatest } from "@catamorphic/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashBearer } from "../services/connections-service.js";
import { dbModelGatewayStore } from "../services/model-gateway.js";

const connectionString = process.env.DATABASE_URL ?? "";
const describeIf = connectionString ? describe : describe.skip;
const schema = `catamorphic_model_usage_${crypto.randomUUID().replaceAll("-", "")}`;
const db = createDatabase({ connectionString, schema, poolSize: 8 });

describeIf("the model gateway's store (ADR 0180)", () => {
  const tenantId = crypto.randomUUID();
  const projectId = crypto.randomUUID();
  const connectionId = crypto.randomUUID();

  beforeAll(async () => {
    await migrateToLatest({ db, schema });
    await db
      .insertInto("tenants")
      .values({ id: tenantId, name: "t" })
      .execute();
    await db
      .insertInto("projects")
      .values({ id: projectId, tenant_id: tenantId, name: "p" })
      .execute();
    await db
      .insertInto("connections")
      .values({
        id: connectionId,
        tenant_id: tenantId,
        provider_kind: "anthropic",
        principal_kind: "tenant_service",
        name: "anthropic",
        label: "Anthropic",
        status: "ready",
        credential_ref: "ref",
      })
      .execute();
  });

  afterAll(async () => {
    await db.schema.dropSchema(schema).cascade().execute();
    await db.destroy();
  });

  /** A session with an Allocation and a live model grant. */
  async function grant() {
    const sessionId = crypto.randomUUID();
    const allocationId = crypto.randomUUID();
    const token = crypto.randomUUID();
    await db
      .insertInto("execution_allocations")
      .values({
        id: allocationId,
        tenant_id: tenantId,
        project_id: projectId,
        environment_name: "build",
        binding_id: "managed",
        workload_kind: "agent",
        root_workload_id: sessionId,
        policy_snapshot: JSON.stringify({}),
      })
      .execute();
    await db
      .insertInto("agent_sessions")
      .values({
        id: sessionId,
        project_id: projectId,
        external_user_id: "member-1",
        provider: "claude-code",
        allocation_id: allocationId,
      })
      .execute();
    await db
      .insertInto("connection_capability_grants")
      .values({
        tenant_id: tenantId,
        project_id: projectId,
        allocation_id: allocationId,
        agent_session_id: sessionId,
        alias: "anthropic",
        connection_id: connectionId,
        token_hash: hashBearer(token),
        capabilities: JSON.stringify(["model"]),
        expires_at: new Date(Date.now() + 60_000),
        channel: "sandbox",
      })
      .execute();
    return { sessionId, allocationId, token };
  }

  it("reads a live grant with its session and connection revision in one query", async () => {
    const store = dbModelGatewayStore(db);
    const { sessionId, allocationId, token } = await grant();
    expect(await store.liveGrant({ token })).toMatchObject({
      tenantId,
      allocationId,
      agentSessionId: sessionId,
      alias: "anthropic",
      session: { ownerId: "member-1", active: true },
      connection: { id: connectionId, revision: 1, status: "ready" },
    });
    expect(await store.liveGrant({ token: "not-a-grant" })).toBeUndefined();
    await db
      .updateTable("agent_sessions")
      .set({ status: "closed" })
      .where("id", "=", sessionId)
      .execute();
    expect((await store.liveGrant({ token }))?.session?.active).toBe(false);
  });

  it("ends a grant with its Allocation or its revocation", async () => {
    const store = dbModelGatewayStore(db);
    const released = await grant();
    await db
      .updateTable("execution_allocations")
      .set({ status: "released", released_at: new Date() })
      .where("id", "=", released.allocationId)
      .execute();
    expect(await store.liveGrant({ token: released.token })).toBeUndefined();
    const revoked = await grant();
    await db
      .updateTable("connection_capability_grants")
      .set({ revoked_at: new Date() })
      .where("allocation_id", "=", revoked.allocationId)
      .execute();
    expect(await store.liveGrant({ token: revoked.token })).toBeUndefined();
  });

  it("records usage per session and turn", async () => {
    const store = dbModelGatewayStore(db);
    const { sessionId, allocationId } = await grant();
    const turnId = crypto.randomUUID();
    const record = {
      tenantId,
      projectId,
      sessionId,
      allocationId,
      connectionId,
      alias: "anthropic",
      endpoint: "v1/messages",
      model: "claude-test-1",
    };
    const usage = {
      inputTokens: 10,
      cachedInputTokens: 2,
      cacheCreationTokens: 1,
      outputTokens: 12,
      reasoningTokens: 0,
    };
    await store.recordUsage({ record: { ...record, turnId }, usage });
    await store.recordUsage({ record: { ...record, turnId }, usage });
    await store.recordUsage({ record: { ...record, turnId: null }, usage });
    expect(await store.usage({ sessionId, turnId })).toEqual({
      model: "claude-test-1",
      inputTokens: 20,
      cachedInputTokens: 4,
      cacheCreationTokens: 2,
      outputTokens: 24,
      reasoningTokens: 0,
    });
    expect((await store.usage({ sessionId }))?.outputTokens).toBe(36);
    expect(await store.runningTurn({ sessionId })).toBeUndefined();
  });
});
