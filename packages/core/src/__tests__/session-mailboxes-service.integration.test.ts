import crypto from "node:crypto";
import type { DB } from "@catamorphic/db";
import { migrateToLatest } from "@catamorphic/db";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { Kysely, PGliteDialect, sql, WithSchemaPlugin } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  SessionAuthorityMismatchError,
  SessionMailboxesService,
} from "../services/session-mailboxes-service.js";

const pglite = new PGlite({ extensions: { pgcrypto } });
const schema = "catamorphic_session_mailboxes";
const db = new Kysely<DB>({
  dialect: new PGliteDialect({ pglite }),
  plugins: [new WithSchemaPlugin(schema)],
});
const tenantId = crypto.randomUUID();
const projectId = crypto.randomUUID();
const sessionId = crypto.randomUUID();
const identity = { tenantId, externalUserId: "person-1" };

describe("session mailboxes", () => {
  const mailboxes = new SessionMailboxesService(db, "source-host");

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
        authority_host_id: "desktop-host",
        authority_revision: 3,
      })
      .execute();
  }, 30_000);

  afterAll(async () => {
    await sql`drop schema if exists ${sql.id(schema)} cascade`.execute(db);
    await db.destroy();
  });

  beforeEach(async () => {
    await db.deleteFrom("session_mailbox_items").execute();
  });

  it("queues idempotently for the exact session authority", async () => {
    const input = {
      destination: { hostId: "desktop-host", revision: 3 },
      content: "PR checks passed",
      author: { kind: "watcher" as const, watcherId: crypto.randomUUID() },
      mode: "next_turn" as const,
      idempotencyKey: "github:delivery-1",
    };
    const first = await mailboxes.enqueue(
      identity,
      projectId,
      sessionId,
      input,
    );
    const replay = await mailboxes.enqueue(
      identity,
      projectId,
      sessionId,
      input,
    );

    expect(first.created).toBe(true);
    expect(replay).toEqual({ ...first, created: false });
    const pending = await mailboxes.list(identity, projectId, {
      destinationHostId: "desktop-host",
    });
    expect(pending).toEqual([
      expect.objectContaining({
        messageId: first.messageId,
        authorityRevision: 3,
        content: "PR checks passed",
        mode: "next_turn",
      }),
    ]);
  });

  it("rejects stale authority and acknowledges only the destination owner's item", async () => {
    await expect(
      mailboxes.enqueue(identity, projectId, sessionId, {
        destination: { hostId: "desktop-host", revision: 2 },
        content: "stale",
        author: { kind: "system", code: "test" },
        mode: "message_only",
      }),
    ).rejects.toBeInstanceOf(SessionAuthorityMismatchError);

    const receipt = await mailboxes.enqueue(identity, projectId, sessionId, {
      destination: { hostId: "desktop-host", revision: 3 },
      content: "current",
      author: { kind: "system", code: "test" },
      mode: "message_only",
    });
    const item = await db
      .selectFrom("session_mailbox_items")
      .select("id")
      .where("message_id", "=", receipt.messageId)
      .executeTakeFirstOrThrow();
    await mailboxes.acknowledge(identity, projectId, item.id, {
      destinationHostId: "desktop-host",
    });
    expect(
      await mailboxes.list(identity, projectId, {
        destinationHostId: "desktop-host",
      }),
    ).toEqual([]);
  });
});
