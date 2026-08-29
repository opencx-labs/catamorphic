import crypto from "node:crypto";
import type { DB } from "@catamorphic/db";
import { migrateToLatest } from "@catamorphic/db";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { Kysely, PGliteDialect, sql, WithSchemaPlugin } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SessionSyncService } from "../services/session-sync-service.js";

const pglite = new PGlite({ extensions: { pgcrypto } });
const schema = "catamorphic_session_sync";
const db = new Kysely<DB>({
  dialect: new PGliteDialect({ pglite }),
  plugins: [new WithSchemaPlugin(schema)],
});
const tenantId = crypto.randomUUID();
const projectId = crypto.randomUUID();
const sessionId = crypto.randomUUID();
const identity = { tenantId, externalUserId: "person-1" };

describe("durable session sync", () => {
  const sync = new SessionSyncService(db);

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
        authority_revision: 3,
      })
      .execute();
  }, 30_000);

  afterAll(async () => {
    await sql`drop schema if exists ${sql.id(schema)} cascade`.execute(db);
    await db.destroy();
  });

  beforeEach(async () => {
    await db.deleteFrom("session_sync_intents").execute();
    await db.deleteFrom("agent_messages").execute();
  });

  it("coalesces newer transcript watermarks without losing retry state", async () => {
    await sync.enqueue({
      identity,
      projectId,
      sessionId,
      destinationKey: "server-a:project-b",
    });
    await db
      .insertInto("agent_messages")
      .values({
        session_id: sessionId,
        role: "user",
        content: "hello",
        author_kind: "user",
        author_payload: {},
        delivery_mode: "next_turn",
      })
      .execute();
    await sync.enqueue({
      identity,
      projectId,
      sessionId,
      destinationKey: "server-a:project-b",
    });

    const claimed = await sync.claimDue({
      workerId: "worker-1",
      limit: 10,
      leaseMs: 30_000,
    });
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({
      authorityRevision: 3,
      messageCount: 1,
      destinationKey: "server-a:project-b",
      attemptCount: 1,
    });
  });

  it("requires the lease owner and exact destination receipt to acknowledge", async () => {
    await db
      .insertInto("agent_messages")
      .values({
        session_id: sessionId,
        role: "user",
        content: "hello",
        author_kind: "user",
        author_payload: {},
        delivery_mode: "next_turn",
      })
      .execute();
    await sync.enqueue({
      identity,
      projectId,
      sessionId,
      destinationKey: "server-a:project-b",
    });
    const [intent] = await sync.claimDue({
      workerId: "worker-1",
      limit: 1,
      leaseMs: 30_000,
    });
    expect(intent).toBeDefined();

    await expect(
      sync.acknowledge({
        intentId: intent!.id,
        workerId: "worker-2",
        authorityRevision: 3,
        messageCount: 1,
      }),
    ).rejects.toThrow("lease");
    await expect(
      sync.acknowledge({
        intentId: intent!.id,
        workerId: "worker-1",
        authorityRevision: 3,
        messageCount: 0,
      }),
    ).rejects.toThrow("watermark");

    await sync.acknowledge({
      intentId: intent!.id,
      workerId: "worker-1",
      authorityRevision: 3,
      messageCount: 1,
    });
    expect(
      await sync.status({
        identity,
        projectId,
        sessionId,
        destinationKey: "server-a:project-b",
      }),
    ).toMatchObject({
      state: "acknowledged",
      acknowledgedAuthorityRevision: 3,
      acknowledgedMessageCount: 1,
    });
  });

  it("reclaims an expired worker lease", async () => {
    await sync.enqueue({
      identity,
      projectId,
      sessionId,
      destinationKey: "server-a:project-b",
    });
    const [first] = await sync.claimDue({
      workerId: "worker-1",
      limit: 1,
      leaseMs: 1,
    });
    expect(first).toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const [reclaimed] = await sync.claimDue({
      workerId: "worker-2",
      limit: 1,
      leaseMs: 30_000,
    });
    expect(reclaimed?.id).toBe(first?.id);
    expect(reclaimed?.attemptCount).toBe(2);
  });
});
