import crypto, { randomUUID } from "node:crypto";
import type { RuntimeRequest } from "@catamorphic/agent-protocol";
import { createDatabase, migrateToLatest } from "@catamorphic/db";
import { FsBackend, ProjectManager } from "@catamorphic/git";
import type { SandboxProvider } from "@catamorphic/sandbox";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type Identity, PROJECT_PRINCIPAL_ID } from "../identity.js";
import { AgentSessionsService } from "../services/agent-sessions-service.js";
import { AccessDeniedError } from "../services/artifact-scope.js";
import { ExecutionAllocationsService } from "../services/execution-allocations-service.js";
import { ExecutionEnvironmentsService } from "../services/execution-environments-service.js";
import { ProjectEnvironmentsService } from "../services/project-environments-service.js";
import { requestFromRow } from "../services/sessions/session-rows.js";
import { testEnvironmentProvider } from "./test-environment.js";

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
  title: "Allow query on connection_prod?",
  origin: { kind: "host" as const, id: "connection_prod" },
  approval: {
    action: "connection_prod · query",
    tool: {
      server: "connection_prod",
      name: "query",
      input: { sql: "select 1" },
    },
  },
};
const unusedSandbox = new Proxy(
  { workspaceRoot: "/unused" } as SandboxProvider,
  {
    get(target, property) {
      if (property in target) return target[property as keyof typeof target];
      return () => {
        throw new Error(`Unexpected sandbox call: ${String(property)}`);
      };
    },
  },
);
let sessions: AgentSessionsService;

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
      title: "Review #42",
      allocation_id: allocationId,
      approvers: input.approvers ? JSON.stringify(input.approvers) : null,
      authority_host_id: "approvals-host",
      authority_revision: 1,
    })
    .execute();
  // A turn working now, which the approval holds.
  await db
    .insertInto("agent_turns")
    .values({ session_id: id, ordinal: 1, status: "running" })
    .execute();
  return id;
}

async function pendingFor(sessionId: string): Promise<RuntimeRequest> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const row = await db
      .selectFrom("agent_runtime_requests")
      .selectAll()
      .where("session_id", "=", sessionId)
      .where("status", "=", "pending")
      .executeTakeFirst();
    if (row) return requestFromRow(row);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("The approval never opened");
}

const answer = (input: {
  identity: Identity;
  sessionId: string;
  request: RuntimeRequest;
  decision: "approved" | "denied";
}) =>
  sessions.command(input.identity, projectId, input.sessionId, {
    type: "respond",
    commandId: randomUUID(),
    requestId: input.request.id,
    response: { kind: "approval", decision: input.decision },
  });

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
    const projectManager = new ProjectManager(new FsBackend("/unused"));
    sessions = new AgentSessionsService(db, {
      hostId: "approvals-host",
      projectManager,
      executionEnvironments: new ExecutionEnvironmentsService(
        new ProjectEnvironmentsService(db, projectManager),
        testEnvironmentProvider(unusedSandbox),
      ),
      executionAllocations: new ExecutionAllocationsService(db),
      codingAgents: {
        defaultAgentId: () => undefined,
        get: () => undefined,
        list: () => [],
      },
    });
  });

  afterAll(async () => {
    await db.schema.dropSchema(schema).cascade().execute();
    await db.destroy();
  });

  it("routes a project chat's ask to its approvers, and an approval resumes the call", async () => {
    const sessionId = await chat({
      owner: PROJECT_PRINCIPAL_ID,
      approvers: { members: ["alice"], roles: ["reviewer"] },
    });
    const decision = sessions.askApproval({ ...ask, sessionId });
    const pending = await pendingFor(sessionId);
    expect(pending.approvers).toEqual(["alice", "bob"]);
    // Thirty minutes by default, not five.
    expect(
      Date.parse(pending.expiresAt ?? "") - Date.parse(pending.createdAt),
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

    // Holding the chat is not enough once approvers are named, and someone
    // who is not an approver cannot answer it.
    await expect(
      answer({
        identity: { tenantId, externalUserId: "dave" },
        sessionId,
        request: pending,
        decision: "approved",
      }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(
      answer({
        identity: member("carol"),
        sessionId,
        request: pending,
        decision: "approved",
      }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
    expect(
      (
        await answer({
          identity: member("bob"),
          sessionId,
          request: pending,
          decision: "approved",
        })
      ).status,
    ).toBe("accepted");
    await expect(decision).resolves.toBe("allow");
    const answered = await db
      .selectFrom("agent_runtime_requests")
      .select("resolved_by_external_user_id")
      .where("request_id", "=", pending.id)
      .executeTakeFirstOrThrow();
    expect(answered.resolved_by_external_user_id).toBe("bob");
  });

  it("refuses at once, with a reason, when no one can approve", async () => {
    const sessionId = await chat({ owner: PROJECT_PRINCIPAL_ID });
    await expect(sessions.askApproval({ ...ask, sessionId })).resolves.toBe(
      "deny",
    );
    expect(
      await db
        .selectFrom("agent_runtime_requests")
        .select("request_id")
        .where("session_id", "=", sessionId)
        .execute(),
    ).toEqual([]);
  });

  it("denies with a reason when the approvers do not answer in time", async () => {
    const sessionId = await chat({
      owner: PROJECT_PRINCIPAL_ID,
      approvers: { members: ["alice"] },
    });
    await expect(
      sessions.askApproval({ ...ask, sessionId, timeoutMs: 400 }),
    ).resolves.toBe("deny");
    const expired = await db
      .selectFrom("agent_runtime_requests")
      .select(["status", "reason"])
      .where("session_id", "=", sessionId)
      .executeTakeFirstOrThrow();
    expect(expired).toEqual({
      status: "expired",
      reason: "Nobody answered in time.",
    });
  });

  it("waits as long as the Environment says", async () => {
    const sessionId = await chat({
      owner: PROJECT_PRINCIPAL_ID,
      approvers: { members: ["alice"] },
      waitMinutes: 90,
    });
    const decision = sessions.askApproval({ ...ask, sessionId });
    const pending = await pendingFor(sessionId);
    expect(
      Math.round(
        (Date.parse(pending.expiresAt ?? "") - Date.parse(pending.createdAt)) /
          60_000,
      ),
    ).toBe(90);
    await answer({
      identity: member("alice"),
      sessionId,
      request: pending,
      decision: "denied",
    });
    await expect(decision).resolves.toBe("deny");
  });

  it("leaves a person's own chat to them, with no one else notified", async () => {
    const sessionId = await chat({ owner: "dana" });
    const decision = sessions.askApproval({ ...ask, sessionId });
    const pending = await pendingFor(sessionId);
    expect(pending.approvers).toEqual([]);
    expect(
      Date.parse(pending.expiresAt ?? "") - Date.parse(pending.createdAt),
    ).toBeLessThanOrEqual(5 * 60_000);
    expect(
      await db
        .selectFrom("user_notification_events")
        .select("id")
        .where("session_id", "=", sessionId)
        .execute(),
    ).toEqual([]);
    await answer({
      identity: { tenantId, externalUserId: "dana" },
      sessionId,
      request: pending,
      decision: "approved",
    });
    await expect(decision).resolves.toBe("allow");
  });
});
