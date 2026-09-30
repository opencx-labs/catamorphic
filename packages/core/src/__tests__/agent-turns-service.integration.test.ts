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

  it("persists progress independently of heartbeats and fences an expired executor", async () => {
    await turns.deliver({
      sessionId: firstSessionId,
      content: "Build",
      author: watcherAuthor,
      mode: "next_turn",
    });
    const turn = await turns.claimNextForSession({
      workerId: "remote-server",
      sessionId: firstSessionId,
    });
    if (!turn?.leaseToken) throw new Error("Expected a lease");
    const progress = {
      turnId: turn.id,
      leaseToken: turn.leaseToken,
      phase: "working" as const,
      activity: "Running tests",
    };
    expect(await turns.progress(progress)).toBe(true);
    const before = await turns.execution({ sessionId: firstSessionId });
    await turns.renewHeld({
      workerId: "remote-server",
      turns: [{ turnId: turn.id, leaseToken: turn.leaseToken }],
    });
    const otherClient = new AgentTurnsService(db);
    expect(await otherClient.execution({ sessionId: firstSessionId })).toEqual(
      before,
    );
    expect(before).toMatchObject({
      status: "running",
      phase: "working",
      activity: "Running tests",
      executorHealthy: true,
    });
    await db
      .updateTable("agent_turns")
      .set({ lease_expires_at: new Date(0) })
      .where("id", "=", turn.id)
      .execute();
    expect(await turns.progress({ ...progress, phase: "saving" })).toBe(false);
    expect(
      await turns.complete({
        turnId: turn.id,
        leaseToken: turn.leaseToken,
        resultMessageId: turn.messageId,
      }),
    ).toBe(false);
    expect(
      await turns.fail({
        turnId: turn.id,
        leaseToken: turn.leaseToken,
        error: "late failure",
      }),
    ).toBe(false);
    expect(
      await otherClient.execution({ sessionId: firstSessionId }),
    ).toMatchObject({
      status: "running",
      phase: "working",
      executorHealthy: false,
    });
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
      turns.claimNextForSession({
        workerId: "worker-a",
        sessionId: firstSessionId,
      }),
      turns.claimNextForSession({
        workerId: "worker-b",
        sessionId: firstSessionId,
      }),
      turns.claimNextForSession({
        workerId: "worker-c",
        sessionId: secondSessionId,
      }),
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

  it("renews only the current lease and persists retry deadlines across service restarts", async () => {
    await turns.deliver({
      sessionId: firstSessionId,
      content: "Do the work",
      author: watcherAuthor,
      mode: "next_turn",
    });
    const turn = await turns.claimNextForSession({
      workerId: "first-process",
      sessionId: firstSessionId,
    });
    if (!turn?.leaseToken) throw new Error("Missing lease");
    expect(
      await turns.renewHeld({
        workerId: "first-process",
        turns: [{ turnId: turn.id, leaseToken: crypto.randomUUID() }],
      }),
    ).toEqual([]);
    expect(
      await turns.renewHeld({
        workerId: "another-process",
        turns: [{ turnId: turn.id, leaseToken: turn.leaseToken }],
      }),
    ).toEqual([]);
    expect(
      await turns.renewHeld({
        workerId: "first-process",
        turns: [{ turnId: turn.id, leaseToken: turn.leaseToken }],
      }),
    ).toEqual([{ turnId: turn.id, cancellationRequested: false }]);
    // A stop requested through any process arrives with the next renewal.
    await db
      .updateTable("agent_turns")
      .set({ cancellation_requested_at: new Date() })
      .where("id", "=", turn.id)
      .execute();
    expect(
      await turns.renewHeld({
        workerId: "first-process",
        turns: [{ turnId: turn.id, leaseToken: turn.leaseToken }],
      }),
    ).toEqual([{ turnId: turn.id, cancellationRequested: true }]);
    await db
      .updateTable("agent_turns")
      .set({ cancellation_requested_at: null })
      .where("id", "=", turn.id)
      .execute();
    const reply = await db
      .insertInto("agent_messages")
      .values({
        session_id: firstSessionId,
        role: "assistant",
        content: "Connection lost",
        metadata: { status: "failed" },
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const retryAt = new Date(Date.now() + 60_000);
    expect(
      await turns.settle({
        turnId: turn.id,
        leaseToken: turn.leaseToken,
        resultMessageId: reply.id,
        error: "Connection lost",
        retryAt,
        attempt: 1,
      }),
    ).toBe(true);
    const restarted = new AgentTurnsService(db);
    // Later work must not jump ahead of a delayed reconnect of this turn.
    const later = await restarted.deliver({
      sessionId: firstSessionId,
      content: "Later work",
      author: watcherAuthor,
      mode: "next_turn",
    });
    expect(
      await restarted.claimNextForSession({
        workerId: "second-process",
        sessionId: firstSessionId,
      }),
    ).toBeNull();
    expect(
      await restarted.listPendingMessages({ sessionId: firstSessionId }),
    ).toHaveLength(1);
    if (!later.turnId) throw new Error("Missing later turn");
    await restarted.cancelQueued({
      sessionId: firstSessionId,
      turnId: later.turnId,
    });
    expect(
      await restarted.renewHeld({
        workerId: "first-process",
        turns: [{ turnId: turn.id, leaseToken: turn.leaseToken }],
      }),
    ).toEqual([]);
    await db
      .updateTable("agent_turns")
      .set({ available_at: new Date(0) })
      .where("id", "=", turn.id)
      .execute();
    expect(
      await restarted.claimNextForSession({
        workerId: "second-process",
        sessionId: firstSessionId,
      }),
    ).toMatchObject({ id: turn.id, resultMessageId: reply.id, attempt: 2 });
  });

  it("cancels a pending reconnect without deleting the failed response", async () => {
    await turns.deliver({
      sessionId: firstSessionId,
      content: "Do the work",
      author: watcherAuthor,
      mode: "next_turn",
    });
    const turn = await turns.claimNextForSession({
      workerId: "worker",
      sessionId: firstSessionId,
    });
    if (!turn?.leaseToken) throw new Error("Missing lease");
    const reply = await db
      .insertInto("agent_messages")
      .values({
        session_id: firstSessionId,
        role: "assistant",
        content: "Connection lost",
        metadata: { status: "failed" },
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await turns.settle({
      turnId: turn.id,
      leaseToken: turn.leaseToken,
      resultMessageId: reply.id,
      error: "Connection lost",
      retryAt: new Date(Date.now() + 60_000),
      attempt: 1,
    });
    await turns.cancelRetries({ sessionId: firstSessionId });
    expect(await turns.listPending({ sessionId: firstSessionId })).toEqual([]);
    expect(
      await db
        .selectFrom("agent_messages")
        .selectAll()
        .where("id", "=", reply.id)
        .executeTakeFirstOrThrow(),
    ).toMatchObject({
      content: "Connection lost",
      metadata: { status: "failed", interrupted: true },
    });
  });

  it("hands a parked question to its answer in one transaction, or settles it when the answer cannot start here", async () => {
    const reply = async () =>
      (
        await db
          .insertInto("agent_messages")
          .values({
            session_id: secondSessionId,
            role: "assistant",
            content: "Which color?",
            metadata: { status: "awaiting_input" },
          })
          .returning("id")
          .executeTakeFirstOrThrow()
      ).id;
    const ask = async () => {
      await turns.deliver({
        sessionId: secondSessionId,
        content: "ask",
        author: watcherAuthor,
        mode: "next_turn",
      });
      const asking = await turns.claimNextForSession({
        workerId: "asking-process",
        sessionId: secondSessionId,
      });
      if (!asking?.leaseToken) throw new Error("Missing lease");
      return { asking, leaseToken: asking.leaseToken, result: await reply() };
    };
    const allocation = await db
      .insertInto("execution_allocations")
      .values({
        tenant_id: tenantId,
        project_id: projectId,
        environment_name: "default",
        binding_id: "default",
        workload_kind: "agent",
        root_workload_id: secondSessionId,
        policy_snapshot: {},
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await db
      .updateTable("agent_sessions")
      .set({ allocation_id: allocation.id })
      .where("id", "=", secondSessionId)
      .execute();
    const anchor = {
      agentId: null,
      providerSessionId: null,
      model: null,
      modelEffort: null,
      allocationId: allocation.id,
    };
    const status = async (id: string) =>
      (
        await db
          .selectFrom("agent_turns")
          .select(["status", "lease_owner"])
          .where("id", "=", id)
          .executeTakeFirstOrThrow()
      ).status;

    // Nothing queued: the question keeps waiting, still claimed.
    let { asking, leaseToken, result } = await ask();
    const handOver = () =>
      turns.continueAfterQuestion({
        turnId: asking.id,
        leaseToken,
        resultMessageId: result,
        sessionId: secondSessionId,
        workerId: "asking-process",
        anchor,
      });
    expect(await handOver()).toEqual({ status: "waiting" });
    expect(await status(asking.id)).toBe("running");

    // The answer arrives: the question settles and this process claims it.
    const answer = await turns.deliver({
      sessionId: secondSessionId,
      content: "Blue",
      author: watcherAuthor,
      mode: "next_turn",
    });
    let outcome = await handOver();
    if (outcome.status !== "settled") throw new Error("Not settled");
    expect(outcome.next?.id).toBe(answer.turnId);
    expect(outcome.next?.leaseOwner).toBe("asking-process");
    expect(await status(asking.id)).toBe("completed");
    await db.deleteFrom("agent_turns").execute();

    // The answer is queued, but a host holds the workspace for maintenance:
    // the question settles, the answer stays queued for whoever can run it,
    // and the harness gives its question up.
    ({ asking, leaseToken, result } = await ask());
    const queued = await turns.deliver({
      sessionId: secondSessionId,
      content: "Green",
      author: watcherAuthor,
      mode: "next_turn",
    });
    await db
      .updateTable("execution_allocations")
      .set({ maintenance_claimed_until: new Date(Date.now() + 60_000) })
      .where("id", "=", allocation.id)
      .execute();
    outcome = await handOver();
    expect(outcome).toEqual({ status: "settled", next: null });
    expect(await status(asking.id)).toBe("completed");
    if (!queued.turnId) throw new Error("Missing turn");
    expect(await status(queued.turnId)).toBe("queued");

    // A lost lease hands nothing over.
    await db.deleteFrom("agent_turns").execute();
    await db
      .updateTable("execution_allocations")
      .set({ maintenance_claimed_until: null })
      .where("id", "=", allocation.id)
      .execute();
    ({ asking, leaseToken, result } = await ask());
    leaseToken = crypto.randomUUID();
    expect(await handOver()).toEqual({ status: "lost" });
  });
});
