import crypto from "node:crypto";
import type { DB } from "@catamorphic/db";
import { migrateToLatest } from "@catamorphic/db";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { Kysely, PGliteDialect, sql, WithSchemaPlugin } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  AgentTurnsService,
  type SessionMessageAuthor,
} from "../services/agent-turns-service.js";

const pglite = new PGlite({ extensions: { pgcrypto } });
const schema = "catamorphic_agent_turns";
const db = new Kysely<DB>({
  dialect: new PGliteDialect({ pglite }),
  plugins: [new WithSchemaPlugin(schema)],
});
const tenantId = crypto.randomUUID();
const projectId = crypto.randomUUID();
const firstSessionId = crypto.randomUUID();
const secondSessionId = crypto.randomUUID();

const watcherAuthor: SessionMessageAuthor = {
  kind: "watcher",
  watcherId: crypto.randomUUID(),
  runId: crypto.randomUUID(),
};

describe("agent turn persistence", () => {
  let turns: AgentTurnsService;

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
      .values([
        {
          id: firstSessionId,
          project_id: projectId,
          external_user_id: "builder",
          provider: "test",
        },
        {
          id: secondSessionId,
          project_id: projectId,
          external_user_id: "builder",
          provider: "test",
        },
      ])
      .execute();
    turns = new AgentTurnsService(db);
  }, 30_000);

  afterAll(async () => {
    await sql`drop schema if exists ${sql.id(schema)} cascade`.execute(db);
    await db.destroy();
  });

  beforeEach(async () => {
    await db.deleteFrom("agent_turns").execute();
    await db.deleteFrom("agent_messages").execute();
  });

  it("persists attributed message-only delivery without creating a turn", async () => {
    const receipt = await turns.deliver({
      sessionId: firstSessionId,
      content: "PR #42 is ready for review",
      author: watcherAuthor,
      mode: "message_only",
      idempotencyKey: "github:delivery:42",
    });

    expect(receipt).toMatchObject({ created: true, mode: "message_only" });
    expect(receipt.turnId).toBeNull();
    expect(await turns.listPending({ sessionId: firstSessionId })).toEqual([]);

    const row = await db
      .selectFrom("agent_messages")
      .select(["author_kind", "author_payload", "delivery_mode"])
      .where("id", "=", receipt.messageId)
      .executeTakeFirstOrThrow();
    expect(row.author_kind).toBe("watcher");
    expect(row.author_payload).toEqual(watcherAuthor);
    expect(row.delivery_mode).toBe("message_only");
  });

  it("deduplicates delivery atomically by session and idempotency key", async () => {
    const input = {
      sessionId: firstSessionId,
      content: "Checks passed",
      author: watcherAuthor,
      mode: "next_turn" as const,
      idempotencyKey: "github:delivery:checks-passed",
    };
    const [first, replay] = await Promise.all([
      turns.deliver(input),
      turns.deliver(input),
    ]);

    expect(new Set([first.messageId, replay.messageId])).toHaveLength(1);
    expect(new Set([first.turnId, replay.turnId])).toHaveLength(1);
    expect([first.created, replay.created].sort()).toEqual([false, true]);
  });

  it("claims at most one turn per session while allowing another session", async () => {
    const first = await turns.deliver({
      sessionId: firstSessionId,
      content: "First session message",
      author: watcherAuthor,
      mode: "next_turn",
    });
    const behindFirst = await turns.deliver({
      sessionId: firstSessionId,
      content: "Wait behind first",
      author: watcherAuthor,
      mode: "next_turn",
    });
    const second = await turns.deliver({
      sessionId: secondSessionId,
      content: "Other session message",
      author: watcherAuthor,
      mode: "next_turn",
    });

    const claims = await Promise.all([
      turns.claimNext({ workerId: "worker-a" }),
      turns.claimNext({ workerId: "worker-b" }),
      turns.claimNext({ workerId: "worker-c" }),
    ]);
    const claimedIds = claims.flatMap((claim) => (claim ? [claim.id] : []));

    expect(claimedIds).toContain(first.turnId);
    expect(claimedIds).toContain(second.turnId);
    expect(claimedIds).not.toContain(behindFirst.turnId);
    expect(claimedIds).toHaveLength(2);
  });

  it("edits, promotes, and cancels only queued turns", async () => {
    const receipt = await turns.deliver({
      sessionId: firstSessionId,
      content: "Original",
      author: watcherAuthor,
      mode: "next_turn",
    });
    if (!receipt.turnId) throw new Error("Expected a turn");

    expect(
      await turns.updateQueued({
        turnId: receipt.turnId,
        sessionId: firstSessionId,
        content: "Edited",
        held: true,
      }),
    ).toBe(true);
    expect(
      await turns.claimNextForSession({
        workerId: "worker",
        sessionId: firstSessionId,
      }),
    ).toBeNull();
    expect(
      await turns.promoteQueued({
        turnId: receipt.turnId,
        sessionId: firstSessionId,
      }),
    ).toBe(true);
    expect(
      await turns.listPendingMessages({ sessionId: firstSessionId }),
    ).toEqual([
      expect.objectContaining({
        id: receipt.turnId,
        content: "Edited",
        deliveryMode: "interrupt",
        status: "queued",
      }),
    ]);
    expect(
      await turns.cancelQueued({
        turnId: receipt.turnId,
        sessionId: firstSessionId,
      }),
    ).toBe(true);
    expect(
      await turns.listPendingMessages({ sessionId: firstSessionId }),
    ).toEqual([]);
  });
});
