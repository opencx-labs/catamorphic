import crypto from "node:crypto";
import { createDatabase, migrateToLatest } from "@catamorphic/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConnectionCapabilityGrantsService } from "../services/connection-capability-grants.js";
import { hashBearer } from "../services/connections-service.js";
import { ExecutionAllocationsService } from "../services/execution-allocations-service.js";
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
    const turnId = crypto.randomUUID();
    const attemptId = crypto.randomUUID();
    const leaseToken = crypto.randomUUID();
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
        policy_snapshot: JSON.stringify({
          binding: {
            id: "managed",
            label: "Managed",
            trust: "managed",
            isolation: "sandbox",
            workloads: ["agent"],
            agentTopologies: ["contained"],
            capabilities: [],
            resources: {},
          },
          requirements: { workload: "agent", topology: "contained" },
          connections: [
            {
              alias: "anthropic",
              connectionId,
              providerKind: "anthropic",
              principalKind: "tenant_service",
              capabilities: ["model", "git:read", "http:GET"],
            },
          ],
        }),
      })
      .execute();
    await db
      .insertInto("agent_sessions")
      .values({
        id: sessionId,
        project_id: projectId,
        external_user_id: "member-1",
        allocation_id: allocationId,
      })
      .execute();
    await db
      .insertInto("agent_turns")
      .values({
        id: turnId,
        session_id: sessionId,
        ordinal: 1,
        status: "running",
        active_attempt_id: attemptId,
        lease_owner: "replica-1",
        lease_token: leaseToken,
        lease_expires_at: new Date(Date.now() + 60_000),
      })
      .execute();
    await db
      .insertInto("agent_turn_attempts")
      .values({
        id: attemptId,
        turn_id: turnId,
        session_id: sessionId,
        ordinal: 1,
        reason: "initial",
        status: "running",
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
        capabilities: JSON.stringify(["model", "git:read", "http:GET"]),
        model_turn_id: turnId,
        model_attempt_id: attemptId,
        model_lease_token: leaseToken,
        expires_at: new Date(Date.now() + 60_000),
        channel: "sandbox",
      })
      .execute();
    return { sessionId, allocationId, token, turnId, attemptId, leaseToken };
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
    expect(await store.liveGrant({ token })).toBeUndefined();
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

  const grants = new ConnectionCapabilityGrantsService(
    db,
    new ExecutionAllocationsService(db),
  );
  const identity = { tenantId, externalUserId: "member-1" };
  function issueArgs(fixture: Awaited<ReturnType<typeof grant>>) {
    return {
      identity,
      allocationId: fixture.allocationId,
      agentSessionId: fixture.sessionId,
      alias: "anthropic",
      channel: "sandbox" as const,
      keepPrevious: true,
      modelTurn: {
        turnId: fixture.turnId,
        attemptId: fixture.attemptId,
        leaseToken: fixture.leaseToken,
      },
    };
  }

  it("denies unbound model use while preserving mixed alias background capabilities", async () => {
    const fixture = await grant();
    const unbound = await grants.issue({
      ...issueArgs(fixture),
      modelTurn: undefined,
    });
    const store = dbModelGatewayStore(db);
    expect(await store.liveGrant({ token: unbound.token })).toBeUndefined();
    expect(await grants.validate({ token: unbound.token })).toMatchObject({
      capabilities: ["model", "git:read", "http:GET"],
    });
    await db
      .updateTable("agent_turns")
      .set({ status: "completed" })
      .where("id", "=", fixture.turnId)
      .execute();
    expect(await store.liveGrant({ token: fixture.token })).toBeUndefined();
    expect(await grants.validate({ token: fixture.token })).not.toBeNull();
    await expect(grants.issue(issueArgs(fixture))).rejects.toThrow(
      "live turn attempt",
    );
  });

  it("denies new calls as soon as cancellation, finalization, lease loss or attempt replacement is persisted", async () => {
    const store = dbModelGatewayStore(db);
    for (const cause of [
      "cancel",
      "finalize",
      "expiry",
      "lease",
      "attempt",
      "move",
      "capability",
    ]) {
      const fixture = await grant();
      expect(await store.liveGrant({ token: fixture.token })).toMatchObject({
        turnId: fixture.turnId,
      });
      if (cause === "move")
        await db
          .updateTable("agent_sessions")
          .set({ allocation_id: null })
          .where("id", "=", fixture.sessionId)
          .execute();
      else if (cause === "capability")
        await db
          .updateTable("connection_capability_grants")
          .set({ capabilities: JSON.stringify(["git:read"]) })
          .where("token_hash", "=", hashBearer(fixture.token))
          .execute();
      else
        await db
          .updateTable("agent_turns")
          .set({
            ...(cause === "cancel"
              ? { cancellation_requested_at: new Date() }
              : {}),
            ...(cause === "finalize" ? { status: "finalizing" } : {}),
            ...(cause === "expiry"
              ? { lease_expires_at: new Date(Date.now() - 1000) }
              : {}),
            ...(cause === "lease" ? { lease_token: crypto.randomUUID() } : {}),
            ...(cause === "attempt"
              ? { active_attempt_id: crypto.randomUUID() }
              : {}),
          })
          .where("id", "=", fixture.turnId)
          .execute();
      expect(
        await store.liveGrant({ token: fixture.token }),
        cause,
      ).toBeUndefined();
      if (cause !== "capability")
        await expect(grants.issue(issueArgs(fixture)), cause).rejects.toThrow(
          "live turn attempt",
        );
    }
  });

  it("never reactivates an old bearer on a later turn, even after extension and late renewal cleanup", async () => {
    const fixture = await grant();
    const oldRenewal = await grants.issue(issueArgs(fixture));
    await db
      .updateTable("agent_turns")
      .set({ status: "completed" })
      .where("id", "=", fixture.turnId)
      .execute();
    const turnId = crypto.randomUUID();
    const attemptId = crypto.randomUUID();
    const leaseToken = crypto.randomUUID();
    await db
      .insertInto("agent_turns")
      .values({
        id: turnId,
        session_id: fixture.sessionId,
        ordinal: 2,
        status: "running",
        active_attempt_id: attemptId,
        lease_token: leaseToken,
        lease_expires_at: new Date(Date.now() + 60_000),
        lease_owner: "replica-2",
      })
      .execute();
    await db
      .insertInto("agent_turn_attempts")
      .values({
        id: attemptId,
        turn_id: turnId,
        session_id: fixture.sessionId,
        ordinal: 1,
        status: "running",
        reason: "initial",
      })
      .execute();
    const next = await grants.issue(
      issueArgs({ ...fixture, turnId, attemptId, leaseToken }),
    );
    await grants.revokeOthers({
      agentSessionId: fixture.sessionId,
      alias: "anthropic",
      channel: "sandbox",
      keepId: oldRenewal.id,
    });
    await grants.extend({
      agentSessionId: fixture.sessionId,
      channel: "sandbox",
    });
    const store = dbModelGatewayStore(db);
    expect(await store.liveGrant({ token: fixture.token })).toBeUndefined();
    expect(await store.liveGrant({ token: oldRenewal.token })).toBeUndefined();
    expect(await store.liveGrant({ token: next.token })).toMatchObject({
      turnId,
    });
    await expect(grants.issue(issueArgs(fixture))).rejects.toThrow(
      "live turn attempt",
    );
    await grants.revokeOthers({
      agentSessionId: fixture.sessionId,
      alias: "anthropic",
      channel: "sandbox",
      keepId: next.id,
    });
    expect(await grants.validate({ token: oldRenewal.token })).toBeNull();
    expect(await store.liveGrant({ token: next.token })).toMatchObject({
      turnId,
    });
  });

  it("does not issue a model grant past a concurrent stop under the turn lock", async () => {
    const fixture = await grant();
    let markLocked = () => {};
    const locked = new Promise<void>((resolve) => {
      markLocked = resolve;
    });
    let release = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stopping = db.transaction().execute(async (trx) => {
      await trx
        .updateTable("agent_turns")
        .set({ cancellation_requested_at: new Date() })
        .where("id", "=", fixture.turnId)
        .execute();
      markLocked();
      await released;
    });
    await locked;
    const issuing = grants.issue(issueArgs(fixture));
    release();
    await stopping;
    await expect(issuing).rejects.toThrow("live turn attempt");
    expect(
      await dbModelGatewayStore(db).liveGrant({ token: fixture.token }),
    ).toBeUndefined();
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

    // A call still streaming is open: it counts once it settles.
    const openId = await store.openUsage({ record: { ...record, turnId } });
    expect(await store.openCalls({ sessionId, turnId })).toBe(1);
    expect(
      await store.openCalls({ sessionId, turnId: crypto.randomUUID() }),
    ).toBe(0);
    expect((await store.usage({ sessionId, turnId }))?.outputTokens).toBe(24);
    await store.recordUsage({ record: { ...record, turnId }, usage, openId });
    expect(await store.openCalls({ sessionId })).toBe(0);
    expect((await store.usage({ sessionId, turnId }))?.outputTokens).toBe(36);

    // A call whose replica died mid-stream never settles; once it is older
    // than any call streams, nothing waits for it.
    const lost = await store.openUsage({ record: { ...record, turnId } });
    expect(await store.openCalls({ sessionId })).toBe(1);
    await db
      .updateTable("model_usage")
      .set({ created_at: new Date(Date.now() - 31 * 60_000) })
      .where("id", "=", lost)
      .execute();
    expect(await store.openCalls({ sessionId })).toBe(0);
    expect(await store.openCalls({ sessionId, turnId })).toBe(0);
  });
});
