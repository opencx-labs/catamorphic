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
        provider: "test",
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
});
