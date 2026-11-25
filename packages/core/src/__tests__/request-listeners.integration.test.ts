import crypto from "node:crypto";
import type { DB, Json } from "@catamorphic/db";
import { migrateToLatest } from "@catamorphic/db";
import type { ProjectManager } from "@catamorphic/git";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { Kysely, PGliteDialect, sql, WithSchemaPlugin } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RunsService } from "../services/runs-service.js";
import {
  REQUEST_OPENED_EVENT,
  requestEventInput,
  requestEventSession,
  requestOpenedEvent,
} from "../services/sessions/request-events.js";
import type { TriggerKindRuntime } from "../services/trigger-kinds.js";
import { TriggersService } from "../services/triggers-service.js";

/*
 * Who listens for a request that opens (ADR 0352): an active project
 * automation bound to `session.request-opened` whose config and `where`
 * match the event, as a dispatch matches them. That is what lets an
 * unattended chat's approval wait instead of being refused at once.
 */

const pglite = new PGlite({ extensions: { pgcrypto } });
const schema = "catamorphic_request_listeners";
const db = new Kysely<DB>({
  dialect: new PGliteDialect({ pglite }),
  plugins: [new WithSchemaPlugin(schema)],
});
const tenantId = crypto.randomUUID();

/** The session kind as a host registers it: config selects an agent. */
const requestOpened: TriggerKindRuntime = {
  name: REQUEST_OPENED_EVENT,
  payloadJsonSchema: { type: "object" },
  configJsonSchema: { type: "object" },
  validatePayload: () => ({ ok: true }),
  validateConfig: () => ({ ok: true }),
  matches: ({ config, payload }) => {
    const wanted = z(config).agentId;
    return wanted === undefined || wanted === z(z(payload).payload).agentId;
  },
};

/** A JSON object's fields, or none. */
function z(value: Json | undefined): { [key: string]: Json | undefined } {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

describe("request listeners (ADR 0352)", () => {
  let triggers: TriggersService;

  beforeAll(async () => {
    await migrateToLatest({ db, schema });
    await db
      .insertInto("tenants")
      .values({ id: tenantId, name: "T" })
      .execute();
    triggers = new TriggersService(db, {
      kinds: [requestOpened],
      // Listening reads bindings only: it starts no run and opens no repository.
      projectManager: undefined as unknown as ProjectManager,
      runs: undefined as unknown as RunsService,
    });
  }, 30_000);

  afterAll(async () => {
    await sql`drop schema if exists ${sql.id(schema)} cascade`.execute(db);
    await db.destroy();
  });

  /** A project with one chat, and a subscription to its request events. */
  async function project(input: {
    owner?: "project" | "member";
    config?: Json;
    where?: Json[];
    activation?: string;
    enablement?: string;
    expiresAt?: Date;
    kind?: string;
    chat?: { agentId?: string; key?: string };
  }): Promise<{ projectId: string; event: Json }> {
    const created = await db
      .insertInto("projects")
      .values({ tenant_id: tenantId, name: "Reviews" })
      .returning("id")
      .executeTakeFirstOrThrow();
    const projectId = created.id;
    const commitSha = "c".repeat(40);
    const artifact = await db
      .insertInto("deployment_artifacts")
      .values({
        project_id: projectId,
        commit_sha: commitSha,
        artifact_digest: "test",
        plugin_digest: "none",
        runtime_version: "test",
        transform_version: "test",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await db
      .insertInto("trigger_definition_scans")
      .values({ project_id: projectId, commit_sha: commitSha })
      .execute();
    const definition = await db
      .insertInto("trigger_definitions")
      .values({
        project_id: projectId,
        commit_sha: commitSha,
        trigger_kind: input.kind ?? REQUEST_OPENED_EVENT,
        workflow_name: "answerRequests",
        config: JSON.stringify(input.config ?? {}),
        where_filters: JSON.stringify(input.where ?? []),
        can_suspend: false,
        input_parameters: JSON.stringify([]),
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const owner = input.owner ?? "project";
    const enablement = await db
      .insertInto("workflow_enablements")
      .values({
        tenant_id: tenantId,
        project_id: projectId,
        workflow_name: "answerRequests",
        deployment_artifact_id: artifact.id,
        commit_sha: commitSha,
        environment_name: "default",
        owner_kind: owner,
        owner_external_user_id: owner === "member" ? "ada" : null,
        owner_identity: { tenantId, externalUserId: "ada" },
        consent_digest: "test",
        created_by_external_user_id: "ada",
        status: input.enablement ?? "active",
        expires_at: input.expiresAt ?? null,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await db
      .insertInto("workflow_enablement_triggers")
      .values({
        enablement_id: enablement.id,
        trigger_definition_id: definition.id,
        status: input.activation ?? "active",
      })
      .execute();
    const sessionId = crypto.randomUUID();
    await db
      .insertInto("agent_sessions")
      .values({
        id: sessionId,
        project_id: projectId,
        external_user_id: "catamorphic:project",
        title: "Review #42",
        agent_id: input.chat?.agentId ?? "reviewer",
        chat_key: input.chat?.key ?? null,
        authority_host_id: "listeners-host",
        authority_revision: 1,
      })
      .execute();
    const now = new Date().toISOString();
    const event = requestOpenedEvent(await requestEventSession(db, sessionId), {
      id: crypto.randomUUID(),
      sessionId,
      turnId: null,
      attemptId: null,
      itemId: null,
      kind: "approval",
      status: "pending",
      answerable: true,
      blocking: true,
      title: "Allow post?",
      description: null,
      origin: { kind: "mcp", id: "connection_github" },
      questions: null,
      approval: {
        action: "connection_github · post",
        tool: {
          server: "connection_github",
          name: "post",
          input: { path: "/repos/acme/web/issues" },
        },
      },
      elicitation: null,
      approvers: [],
      expiresAt: null,
      response: null,
      resolvedBy: null,
      reason: null,
      createdAt: now,
      resolvedAt: null,
    });
    return { projectId, event: requestEventInput(event) };
  }

  const listens = (input: { projectId: string; event: Json }) =>
    triggers.projectListens({
      projectId: input.projectId,
      kind: REQUEST_OPENED_EVENT,
      payload: input.event,
    });

  it("hears a project automation bound to the event, and only one that is live", async () => {
    expect(await listens(await project({}))).toBe(true);
    // A member's own automation acts for one person, never for the project.
    expect(await listens(await project({ owner: "member" }))).toBe(false);
    expect(await listens(await project({ activation: "paused" }))).toBe(false);
    expect(await listens(await project({ enablement: "suspended" }))).toBe(
      false,
    );
    expect(
      await listens(
        await project({ expiresAt: new Date(Date.now() - 60_000) }),
      ),
    ).toBe(false);
    // Bound to another event of the chat.
    expect(await listens(await project({ kind: "session.turn-changed" }))).toBe(
      false,
    );
  });

  it("matches the binding's config and where as a dispatch does", async () => {
    // Config selects the agent.
    expect(
      await listens(await project({ config: { agentId: "reviewer" } })),
    ).toBe(true);
    expect(
      await listens(await project({ config: { agentId: "auditor" } })),
    ).toBe(false);
    // `where` selects the request's kind and the tool it asks for.
    const posts = {
      payload: {
        detail: {
          kind: "approval",
          approval: { tool: { server: "connection_github", name: "post" } },
        },
      },
    };
    expect(await listens(await project({ where: [posts] }))).toBe(true);
    expect(
      await listens(
        await project({
          where: [{ payload: { detail: { kind: "question" } } }],
        }),
      ),
    ).toBe(false);
    // And a family of keyed chats: a chat without the key is not heard.
    const pullRequests = {
      payload: { session: { key: { $prefix: "pr-" } } },
    };
    expect(
      await listens(
        await project({
          where: [pullRequests],
          chat: { key: "pr-acme/web-42" },
        }),
      ),
    ).toBe(true);
    expect(await listens(await project({ where: [pullRequests] }))).toBe(false);
  });

  it("asks about the event a bound workflow receives, as the session kinds describe it", async () => {
    const { projectId, event } = await project({
      chat: { key: "pr-acme/web-42" },
    });
    // Every field the registered session kinds require (server-sdk's
    // `sessionEventPayload`), under the names the other session events use.
    expect(event).toEqual({
      id: expect.any(String),
      sequence: 0,
      projectId,
      source: "session",
      kind: REQUEST_OPENED_EVENT,
      externalId: expect.any(String),
      occurredAt: expect.any(String),
      receivedAt: expect.any(String),
      payload: {
        sessionId: expect.any(String),
        agentId: "reviewer",
        externalUserId: "catamorphic:project",
        session: {
          id: expect.any(String),
          key: "pr-acme/web-42",
          title: "Review #42",
          status: "active",
          workStatus: "open",
          activity: null,
          parentSessionId: null,
          stateRevision: expect.any(Number),
          authorityHostId: "listeners-host",
          authorityRevision: 1,
        },
        actor: { kind: "system", code: REQUEST_OPENED_EVENT },
        causation: [],
        detail: {
          requestId: expect.any(String),
          kind: "approval",
          blocking: true,
          title: "Allow post?",
          description: null,
          origin: { kind: "mcp", id: "connection_github" },
          approval: {
            action: "connection_github · post",
            tool: {
              server: "connection_github",
              name: "post",
              input: { path: "/repos/acme/web/issues" },
            },
          },
          questions: null,
          elicitation: null,
          turnId: null,
          attemptId: null,
          expiresAt: null,
        },
      },
    });
  });

  it("hears nothing for a kind the host does not register", async () => {
    const { projectId, event } = await project({});
    expect(
      await triggers.projectListens({
        projectId,
        kind: "session.unknown",
        payload: event,
      }),
    ).toBe(false);
  });
});
