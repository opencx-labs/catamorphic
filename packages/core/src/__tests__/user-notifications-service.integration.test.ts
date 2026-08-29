import crypto from "node:crypto";
import type { DB } from "@catamorphic/db";
import { migrateToLatest } from "@catamorphic/db";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { Kysely, PGliteDialect, sql, WithSchemaPlugin } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { UserNotificationsService } from "../services/user-notifications-service.js";

const pglite = new PGlite({ extensions: { pgcrypto } });
const schema = "catamorphic_user_notifications";
const db = new Kysely<DB>({
  dialect: new PGliteDialect({ pglite }),
  plugins: [new WithSchemaPlugin(schema)],
});
const tenantId = crypto.randomUUID();
const projectId = crypto.randomUUID();
const sessionId = crypto.randomUUID();
const identity = { tenantId, externalUserId: "person-1" };
const sent: string[] = [];
const notifications = new UserNotificationsService(db, {
  publicKey: "test-public-key",
  send: async ({ payload }) => {
    sent.push(payload);
    return "delivered";
  },
});

describe("durable user notifications", () => {
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
      .insertInto("agent_sessions")
      .values({
        id: sessionId,
        project_id: projectId,
        external_user_id: identity.externalUserId,
        provider: "test",
        authority_host_id: "desktop-1",
        authority_revision: 2,
        authority_seen_at: new Date(0),
        mirror_message_count: 4,
      })
      .execute();
  }, 30_000);

  beforeEach(async () => {
    sent.length = 0;
    await db.deleteFrom("notification_deliveries").execute();
    await db.deleteFrom("user_notification_events").execute();
    await db.deleteFrom("push_subscriptions").execute();
    await notifications.subscribe(identity, {
      endpoint: "https://push.example/subscription",
      expirationTime: null,
      keys: { p256dh: "key", auth: "secret" },
    });
  });

  afterAll(async () => {
    await sql`drop schema if exists ${sql.id(schema)} cascade`.execute(db);
    await db.destroy();
  });

  it("deduplicates events and delivers each device receipt durably", async () => {
    const event = {
      identity,
      projectId,
      sessionId,
      kind: "agent_completed",
      title: "An agent finished",
      body: "Open the chat.",
      route: `/?project=${projectId}&session=${sessionId}`,
      collapseKey: "turn:1",
    };
    await notifications.publish(event);
    await notifications.publish(event);

    expect(await notifications.drain("worker-1")).toBe(1);
    expect(await notifications.drain("worker-1")).toBe(0);
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0] ?? "{}")).toMatchObject({
      kind: "agent_completed",
      route: event.route,
    });
  });

  it("publishes a paused-session alert that opens the ordinary chats list", async () => {
    expect(
      await notifications.publishPausedSessions({
        authorityHostId: "server-1",
        authorityLeaseMs: 1,
      }),
    ).toBe(1);
    await notifications.drain("worker-1");
    const payload = JSON.parse(sent[0] ?? "{}") as Record<string, string>;
    expect(payload.kind).toBe("sessions_paused");
    expect(payload.route).toBe(`/?project=${projectId}`);
    expect(`${payload.title} ${payload.body}`.toLowerCase()).not.toContain(
      "recovery",
    );
  });

  it("never calls a session paused when this server owns its authority", async () => {
    await db
      .updateTable("agent_sessions")
      .set({ authority_host_id: "server-1", authority_seen_at: new Date(0) })
      .where("id", "=", sessionId)
      .execute();
    expect(
      await notifications.publishPausedSessions({
        authorityHostId: "server-1",
        authorityLeaseMs: 1,
      }),
    ).toBe(0);
  });
});
