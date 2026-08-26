import crypto from "node:crypto";
import { createDatabase, migrateToLatest } from "@catamorphic/db";
import type { AgentRuntimeRequest } from "@catamorphic/sandbox";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Identity } from "../identity.js";
import {
  AgentRequestAlreadyResolvedError,
  AgentRuntimeRequestsService,
} from "../services/agent-runtime-requests-service.js";
import { AccessDeniedError } from "../services/artifact-scope.js";

const connectionString = process.env.DATABASE_URL ?? "";
const describeIf = connectionString ? describe : describe.skip;
const schema = `catamorphic_agent_runtime_requests_${crypto.randomUUID().replaceAll("-", "")}`;
const db = createDatabase({ connectionString, schema, poolSize: 4 });

const identity: Identity = {
  tenantId: crypto.randomUUID(),
  externalUserId: "runtime-requests-test",
};
const projectId = crypto.randomUUID();
const sessionId = crypto.randomUUID();

function question(requestId: string): AgentRuntimeRequest {
  return {
    kind: "question",
    requestId,
    sessionId,
    status: "pending",
    createdAt: "2026-08-24T00:00:00.000Z",
    origin: { kind: "provider", id: "test" },
    title: "Pick one",
    question: {
      prompt: "Which option?",
      options: [{ id: "yes", label: "Yes" }],
    },
  };
}

describeIf("agent runtime request persistence", () => {
  let requests: AgentRuntimeRequestsService;

  beforeAll(async () => {
    await migrateToLatest({ db, schema });
    await db
      .insertInto("tenants")
      .values({ id: identity.tenantId, name: "T" })
      .execute();
    await db
      .insertInto("projects")
      .values({ id: projectId, tenant_id: identity.tenantId, name: "P" })
      .execute();
    await db
      .insertInto("agent_sessions")
      .values({
        id: sessionId,
        project_id: projectId,
        external_user_id: identity.externalUserId,
        provider: "test",
      })
      .execute();
    requests = new AgentRuntimeRequestsService(db);
  });

  afterAll(async () => {
    await db.schema.dropSchema(schema).cascade().execute();
    await db.destroy();
  });

  async function createSession(
    input: { agentId?: string | null; externalUserId?: string } = {},
  ): Promise<string> {
    const id = crypto.randomUUID();
    await db
      .insertInto("agent_sessions")
      .values({
        id,
        project_id: projectId,
        external_user_id: input.externalUserId ?? identity.externalUserId,
        provider: "test",
        agent_id: input.agentId ?? null,
      })
      .execute();
    return id;
  }

  it("allows a pending question to be answered once", async () => {
    const request = question(crypto.randomUUID());
    await requests.create({ identity, request });

    await requests.respond({
      identity,
      sessionId,
      requestId: request.requestId,
      response: { kind: "question", answers: ["yes"] },
    });

    await expect(
      requests.respond({
        identity,
        sessionId,
        requestId: request.requestId,
        response: { kind: "question", answers: ["yes"] },
      }),
    ).rejects.toBeInstanceOf(AgentRequestAlreadyResolvedError);
  });

  it("canonicalizes omitted optional request fields before replay comparison", async () => {
    const canonicalSession = await createSession();
    const first = {
      ...question(crypto.randomUUID()),
      sessionId: canonicalSession,
    };
    const replay = {
      ...first,
      turnId: undefined,
    } satisfies AgentRuntimeRequest;

    expect(await requests.create({ identity, request: first })).toEqual({
      inserted: true,
    });
    expect(await requests.create({ identity, request: replay })).toEqual({
      inserted: false,
    });
  });

  it("applies only one terminal outcome when response races expiry", async () => {
    const racingSession = await createSession();
    const request = {
      ...question(crypto.randomUUID()),
      sessionId: racingSession,
      expiresAt: "2020-01-01T00:00:00.000Z",
    };
    await requests.create({ identity, request });

    const outcomes = await Promise.allSettled([
      requests.respond({
        identity,
        sessionId: racingSession,
        requestId: request.requestId,
        response: { kind: "question", answers: ["yes"] },
      }),
      requests.expire({ identity, sessionId: racingSession }),
    ]);
    const row = await db
      .selectFrom("agent_runtime_requests")
      .select(["revision", "status"])
      .where("session_id", "=", racingSession)
      .where("request_id", "=", request.requestId)
      .executeTakeFirstOrThrow();

    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(row.status === "resolved" ? 2 : 1);
    expect(row.status).toMatch(/^(resolved|expired)$/);
    expect(row.revision).toBe(1);
  });

  it("applies the shared session access rule to request writes", async () => {
    const agentId = `project:${projectId}:csm`;
    const scopedSession = await createSession({
      agentId,
      externalUserId: "alice",
    });
    const documentOnly = {
      tenantId: identity.tenantId,
      externalUserId: "alice",
      scope: [{ kind: "document" as const, projectId, path: "notes.md" }],
    };

    await expect(
      requests.create({
        identity: documentOnly,
        request: { ...question(crypto.randomUUID()), sessionId: scopedSession },
      }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
  });
});
