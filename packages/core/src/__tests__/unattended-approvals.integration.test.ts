import crypto from "node:crypto";
import { createDatabase, migrateToLatest } from "@catamorphic/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type Identity, PROJECT_PRINCIPAL_ID } from "../identity.js";
import { AccessDeniedError } from "../services/artifact-scope.js";
import { DurableToolPermissionBroker } from "../services/durable-tool-permission-broker.js";

const connectionString = process.env.DATABASE_URL ?? "";
const describeIf = connectionString ? describe : describe.skip;
const schema = `catamorphic_unattended_approvals_${crypto.randomUUID().replaceAll("-", "")}`;
const db = createDatabase({ connectionString, schema, poolSize: 4 });

const tenantId = crypto.randomUUID();
const projectId = crypto.randomUUID();
/** A member whose role reaches nothing of the chat but may approve. */
const member = (externalUserId: string): Identity => ({
  tenantId,
  externalUserId,
  scope: [],
});
const ask = {
  server: "connection_prod",
  tool: "query",
  description: "Needs your approval: production data",
  input: { sql: "select 1" },
};

async function chat(input: {
  owner: string;
  approvers?: { members?: string[]; roles?: string[] };
  waitMinutes?: number;
}): Promise<string> {
  const id = crypto.randomUUID();
  const allocationId = crypto.randomUUID();
  await db
    .insertInto("execution_allocations")
    .values({
      id: allocationId,
      tenant_id: tenantId,
      project_id: projectId,
      environment_name: "review",
      binding_id: "local",
      workload_kind: "agent",
      root_workload_id: id,
      policy_snapshot: JSON.stringify({
        binding: {
          id: "local",
          label: "local",
          trust: "managed",
          isolation: "sandbox",
          workloads: ["agent"],
          agentTopologies: ["controller"],
          capabilities: [],
          resources: {},
        },
        requirements: { workload: "agent" },
        ...(input.waitMinutes
          ? { approvals: { waitMinutes: input.waitMinutes } }
          : {}),
      }),
    })
    .execute();
  await db
    .insertInto("agent_sessions")
    .values({
      id,
      project_id: projectId,
      external_user_id: input.owner,
      provider: "test",
      title: "Review #42",
      allocation_id: allocationId,
      approvers: input.approvers ? JSON.stringify(input.approvers) : null,
    })
    .execute();
  return id;
}

async function pendingFor(broker: DurableToolPermissionBroker, id: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const [entry] = await broker.list(id);
    if (entry) return entry;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("The ask never parked");
}

describeIf("unattended approvals (ADR 0176)", () => {
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
    await db
      .insertInto("memberships")
      .values([
        {
          project_id: projectId,
          external_user_id: "bob",
          roles: JSON.stringify(["reviewer"]),
        },
        {
          project_id: projectId,
          external_user_id: "carol",
          roles: JSON.stringify(["viewer"]),
        },
      ])
      .execute();
  });

  afterAll(async () => {
    await db.schema.dropSchema(schema).cascade().execute();
    await db.destroy();
  });

  it("routes a project chat's ask to its approvers, and an approval resumes the call", async () => {
    const broker = new DurableToolPermissionBroker(db);
    const sessionId = await chat({
      owner: PROJECT_PRINCIPAL_ID,
      approvers: { members: ["alice"], roles: ["reviewer"] },
    });
    const decision = broker.handlerFor("Reviewer")({ ...ask, sessionId });
    const pending = await pendingFor(broker, sessionId);
    expect(pending.approvers).toEqual(["alice", "bob"]);
    // Thirty minutes by default, not five.
    expect(
      Date.parse(pending.expiresAt) - Date.parse(pending.createdAt),
    ).toBeGreaterThan(29 * 60_000);

    // Approvers are notified right after the request is recorded.
    await vi.waitFor(async () => {
      const notified = await db
        .selectFrom("user_notification_events")
        .select(["external_user_id", "kind", "route"])
        .where("session_id", "=", sessionId)
        .orderBy("external_user_id")
        .execute();
      expect(notified.map((row) => [row.external_user_id, row.kind])).toEqual([
        ["alice", "approval_requested"],
        ["bob", "approval_requested"],
      ]);
      const views = await db
        .selectFrom("agent_session_views")
        .select(["external_user_id", "visibility"])
        .where("session_id", "=", sessionId)
        .orderBy("external_user_id")
        .execute();
      expect(views).toEqual([
        { external_user_id: "alice", visibility: "promoted" },
        { external_user_id: "bob", visibility: "promoted" },
      ]);
    });

    // Holding the chat is not enough once approvers are named.
    await expect(
      broker.answer(
        pending.id,
        { decision: "allow" },
        { tenantId, externalUserId: "dave" },
      ),
    ).rejects.toBeInstanceOf(AccessDeniedError);
    // Someone who is not an approver cannot answer it.
    await expect(
      broker.answer(pending.id, { decision: "allow" }, member("carol")),
    ).rejects.toBeInstanceOf(AccessDeniedError);
    expect(
      await broker.answer(pending.id, { decision: "allow" }, member("bob")),
    ).toBe(true);
    await expect(decision).resolves.toEqual({ decision: "allow" });
    const answered = await db
      .selectFrom("agent_runtime_requests")
      .select("resolved_by_external_user_id")
      .where("request_id", "=", pending.id)
      .executeTakeFirstOrThrow();
    expect(answered.resolved_by_external_user_id).toBe("bob");
  });

  it("refuses at once, with a reason, when no one can approve", async () => {
    const broker = new DurableToolPermissionBroker(db);
    const sessionId = await chat({ owner: PROJECT_PRINCIPAL_ID });
    const decision = await broker.handlerFor("Reviewer")({ ...ask, sessionId });
    expect(decision.decision).toBe("deny");
    expect(decision.decision === "deny" && decision.reason).toContain(
      "no one watches this chat",
    );
    expect(await broker.list(sessionId)).toEqual([]);
  });

  it("denies with a reason when the approvers do not answer in time", async () => {
    const broker = new DurableToolPermissionBroker(db, {
      unattendedTimeoutMs: 400,
    });
    const sessionId = await chat({
      owner: PROJECT_PRINCIPAL_ID,
      approvers: { members: ["alice"] },
    });
    const decision = await broker.handlerFor("Reviewer")({ ...ask, sessionId });
    expect(decision).toMatchObject({ decision: "deny" });
    expect(decision.decision === "deny" && decision.reason).toContain(
      "No one answered",
    );
  });

  it("waits as long as the Environment says", async () => {
    const broker = new DurableToolPermissionBroker(db);
    const sessionId = await chat({
      owner: PROJECT_PRINCIPAL_ID,
      approvers: { members: ["alice"] },
      waitMinutes: 90,
    });
    const decision = broker.handlerFor("Reviewer")({ ...ask, sessionId });
    const pending = await pendingFor(broker, sessionId);
    expect(
      Math.round(
        (Date.parse(pending.expiresAt) - Date.parse(pending.createdAt)) /
          60_000,
      ),
    ).toBe(90);
    await broker.answer(pending.id, { decision: "deny" }, member("alice"));
    await expect(decision).resolves.toEqual({ decision: "deny" });
  });

  it("leaves a person's own chat to them, with no one else notified", async () => {
    const broker = new DurableToolPermissionBroker(db, { timeoutMs: 60_000 });
    const sessionId = await chat({ owner: "dana" });
    const decision = broker.handlerFor("Assistant")({ ...ask, sessionId });
    const pending = await pendingFor(broker, sessionId);
    expect(pending.approvers).toBeUndefined();
    expect(
      await db
        .selectFrom("user_notification_events")
        .select("id")
        .where("session_id", "=", sessionId)
        .execute(),
    ).toEqual([]);
    await broker.answer(
      pending.id,
      { decision: "allow" },
      { tenantId, externalUserId: "dana" },
    );
    await expect(decision).resolves.toEqual({ decision: "allow" });
  });
});
