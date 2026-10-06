import crypto from "node:crypto";
import type { DB } from "@catamorphic/db";
import { migrateToLatest } from "@catamorphic/db";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { Kysely, PGliteDialect, sql, WithSchemaPlugin } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Identity } from "../identity.js";
import { ProjectEventMonitorsService } from "../services/project-event-monitors-service.js";
import { ProjectEventsService } from "../services/project-events-service.js";

const pglite = new PGlite({ extensions: { pgcrypto } });
const schema = "catamorphic_project_events";
const db = new Kysely<DB>({
  dialect: new PGliteDialect({ pglite }),
  plugins: [new WithSchemaPlugin(schema)],
});
const tenantId = crypto.randomUUID();
const projectId = crypto.randomUUID();
const identity: Identity = { tenantId, externalUserId: "builder" };

describe("project events", () => {
  let events: ProjectEventsService;

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
    events = new ProjectEventsService(db);
  }, 30_000);

  afterAll(async () => {
    await sql`drop schema if exists ${sql.id(schema)} cascade`.execute(db);
    await db.destroy();
  });

  it("deduplicates provider delivery and preserves a replay cursor", async () => {
    const input = {
      projectId,
      source: "github",
      kind: "github.pull_request",
      externalId: "github-event-123",
      occurredAt: "2026-08-28T10:00:00.000Z",
      payload: { action: "synchronize", number: 42 },
    };
    const first = await events.append(input);
    const replay = await events.append(input);

    expect(first.created).toBe(true);
    expect(replay).toEqual({ ...first, created: false });
    expect(
      await events.list({ projectId, afterSequence: 0, limit: 10 }),
    ).toEqual([
      expect.objectContaining({
        sequence: first.event.sequence,
        source: "github",
        kind: "github.pull_request",
        externalId: "github-event-123",
      }),
    ]);
  });

  it("appends a tenant-wide event once to each project with a live activation of its kind, in the caller's transaction", async () => {
    /** A project with one activation of `kind` in the given state. */
    const subscriber = async (input: {
      kind: string;
      tenant?: string;
      activation?: string;
      enablement?: string;
      expiresAt?: Date;
    }) => {
      const tenant = input.tenant ?? tenantId;
      if (input.tenant)
        await db
          .insertInto("tenants")
          .values({ id: tenant, name: "Other" })
          .onConflict((conflict) => conflict.column("id").doNothing())
          .execute();
      const project = await db
        .insertInto("projects")
        .values({ tenant_id: tenant, name: input.kind })
        .returning("id")
        .executeTakeFirstOrThrow();
      const commitSha = "c".repeat(40);
      const artifact = await db
        .insertInto("deployment_artifacts")
        .values({
          project_id: project.id,
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
        .values({ project_id: project.id, commit_sha: commitSha })
        .execute();
      const definition = await db
        .insertInto("trigger_definitions")
        .values({
          project_id: project.id,
          commit_sha: commitSha,
          trigger_kind: input.kind,
          workflow_name: "onboard",
          config: JSON.stringify({}),
          can_suspend: false,
          input_parameters: JSON.stringify([]),
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      const enablement = await db
        .insertInto("workflow_enablements")
        .values({
          tenant_id: tenant,
          project_id: project.id,
          workflow_name: "onboard",
          deployment_artifact_id: artifact.id,
          commit_sha: commitSha,
          environment_name: "default",
          owner_kind: "project",
          owner_identity: { tenantId: tenant, externalUserId: "builder" },
          consent_digest: "test",
          created_by_external_user_id: "builder",
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
      return project.id;
    };
    const kind = "directory.member-joined";
    const listening = await subscriber({ kind });
    await subscriber({ kind: "directory.member-left" });
    await subscriber({ kind, activation: "paused" });
    await subscriber({ kind, enablement: "suspended" });
    await subscriber({ kind, expiresAt: new Date(Date.now() - 60_000) });
    await subscriber({ kind, tenant: crypto.randomUUID() });
    const event = {
      tenantId,
      source: "directory",
      kind,
      externalId: `${kind}:user-1:1`,
      occurredAt: "2026-10-06T09:00:00.000Z",
      payload: { member: { id: "user-1" }, groups: [] },
    };
    const stored = () =>
      db
        .selectFrom("project_events")
        .select("project_id")
        .where("source", "=", "directory")
        .execute();

    // A transition whose transaction fails leaves no event behind.
    await expect(
      db.transaction().execute(async (transaction) => {
        await events.appendToSubscribers({ ...event, transaction });
        throw new Error("the transition was not recorded");
      }),
    ).rejects.toThrow("the transition was not recorded");
    expect(await stored()).toEqual([]);

    const first = await events.appendToSubscribers(event);
    expect(first.events.map((appended) => appended.projectId)).toEqual([
      listening,
    ]);
    const replay = await events.appendToSubscribers(event);
    expect(replay.events).toEqual(first.events);
    expect(await stored()).toEqual([{ project_id: listening }]);
  });

  it("claims a placement-compatible monitor with a durable cursor lease", async () => {
    const monitors = new ProjectEventMonitorsService(db);
    const monitor = await monitors.ensure({
      identity,
      projectId,
      sourceKind: "github",
      sourceKey: "octo/repo",
      placement: "local",
      cursor: { externalId: "100" },
      pollIntervalSeconds: 30,
    });

    expect(
      await monitors.claim({ workerId: "desktop", placement: "local" }),
    ).toBeNull();
    const sessionId = crypto.randomUUID();
    const artifactId = crypto.randomUUID();
    await db
      .insertInto("agent_sessions")
      .values({
        id: sessionId,
        project_id: projectId,
        external_user_id: "builder",
      })
      .execute();
    await db
      .insertInto("deployment_artifacts")
      .values({
        id: artifactId,
        project_id: projectId,
        commit_sha: "a".repeat(40),
        artifact_digest: "test",
        plugin_digest: "none",
        runtime_version: "test",
        transform_version: "test",
      })
      .execute();
    const watcher = await db
      .insertInto("watchers")
      .values({
        project_id: projectId,
        session_id: sessionId,
        monitor_id: monitor.id,
        owner_external_user_id: "builder",
        owner_identity: { tenantId, externalUserId: identity.externalUserId },
        workflow_name: "watch",
        source_path: "watch.ts",
        remote_branch: "watch",
        commit_sha: "a".repeat(40),
        deployment_artifact_id: artifactId,
        expires_at: new Date(Date.now() + 60_000),
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    const claim = await monitors.claim({
      workerId: "desktop",
      placement: "local",
    });
    expect(claim).toMatchObject({
      id: monitor.id,
      tenantId,
      cursor: { externalId: "100" },
    });
    if (!claim?.leaseToken) throw new Error("Expected a monitor lease");
    await monitors.complete({
      monitorId: claim.id,
      leaseToken: claim.leaseToken,
      cursor: { externalId: "101" },
    });
    expect(
      await monitors.claim({ workerId: "desktop", placement: "local" }),
    ).toBeNull();
    await db
      .updateTable("project_event_monitors")
      .set({ next_poll_at: new Date(0) })
      .where("id", "=", monitor.id)
      .execute();
    await db
      .updateTable("watchers")
      .set({ status: "stopped" })
      .where("id", "=", watcher.id)
      .execute();
    expect(
      await monitors.claim({ workerId: "desktop", placement: "local" }),
    ).toBeNull();
    await db
      .updateTable("watchers")
      .set({ status: "active", expires_at: new Date(0) })
      .where("id", "=", watcher.id)
      .execute();
    expect(
      await monitors.claim({ workerId: "desktop", placement: "local" }),
    ).toBeNull();
  });

  it("keeps a source's bare string cursor as the string it is", async () => {
    const monitors = new ProjectEventMonitorsService(db);
    // A Slack `ts` looks like a number; a page token is plain text.
    for (const cursor of ["1695.001", "page-token-7"]) {
      const monitor = await monitors.ensure({
        identity,
        projectId,
        sourceKind: "slack",
        sourceKey: `channel-${cursor}`,
        placement: "local",
        cursor,
      });
      const stored = await db
        .selectFrom("project_event_monitors")
        .select("cursor")
        .where("id", "=", monitor.id)
        .executeTakeFirstOrThrow();
      expect(stored.cursor).toBe(cursor);
    }
  });
});
