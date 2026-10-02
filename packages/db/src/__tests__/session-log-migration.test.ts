import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { Kysely, PGliteDialect, sql } from "kysely";
import { afterAll, describe, expect, it } from "vitest";
import { migrateToLatest } from "../migrate.js";

/*
 * Migration 045 turns existing chats into the session log (ADR 0196):
 * messages become items in order, step logs become work items, turns keep
 * their outcome, a turn caught running reads as interrupted, a queued turn
 * has made no attempt, messages outside a turn belong to none, native
 * threads are unavailable (the next turn is handed the history), and the
 * log continues after the converted history.
 */

const schema = "session_log_migration";
const pglite = new PGlite({ extensions: { pgcrypto } });
const db = new Kysely<unknown>({ dialect: new PGliteDialect({ pglite }) });

afterAll(async () => {
  await db.destroy();
});

const tenantId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const sessionId = "33333333-3333-4333-8333-333333333333";
const builtInSessionId = "33333333-3333-4333-8333-333333333334";
const ids = {
  ask: "44444444-4444-4444-8444-444444444441",
  reply: "44444444-4444-4444-8444-444444444442",
  second: "44444444-4444-4444-8444-444444444443",
  partial: "44444444-4444-4444-8444-444444444444",
  aside: "44444444-4444-4444-8444-444444444445",
  system: "44444444-4444-4444-8444-444444444446",
  queued: "44444444-4444-4444-8444-444444444447",
  builtInAsk: "44444444-4444-4444-8444-444444444448",
  builtInReply: "44444444-4444-4444-8444-444444444449",
  turnOne: "55555555-5555-4555-8555-555555555551",
  turnTwo: "55555555-5555-4555-8555-555555555552",
  turnThree: "55555555-5555-4555-8555-555555555553",
  builtInTurn: "55555555-5555-4555-8555-555555555554",
};

describe("migration 045", () => {
  it("converts existing chats into the session log", {
    timeout: 120_000,
  }, async () => {
    // Everything before 045, then a chat as the old schema held it.
    await sql.raw(`CREATE SCHEMA IF NOT EXISTS ${schema}`).execute(db);
    await pglite.exec(
      `CREATE TABLE ${schema}._migrations (id SERIAL PRIMARY KEY, name VARCHAR(255) NOT NULL UNIQUE, applied_at TIMESTAMPTZ NOT NULL DEFAULT now());
       INSERT INTO ${schema}._migrations (name) VALUES ('045_agent_session_log.sql');`,
    );
    await migrateToLatest({ db, schema });
    const run = async (statement: string) => {
      await pglite.exec(`SET search_path TO ${schema}`);
      return pglite.query(statement);
    };
    await run(`INSERT INTO tenants (id, name) VALUES ('${tenantId}', 'T')`);
    await run(
      `INSERT INTO projects (id, tenant_id, name) VALUES ('${projectId}', '${tenantId}', 'P')`,
    );
    await run(`INSERT INTO agent_sessions (id, project_id, external_user_id, provider, provider_session_id)
               VALUES ('${sessionId}', '${projectId}', 'ada', 'claude-code', 'native-1'),
                      ('${builtInSessionId}', '${projectId}', 'ada', 'ai-sdk', 'native-2')`);
    await run(`INSERT INTO agent_messages (id, session_id, role, content, author_kind, author_payload, delivery_mode, metadata) VALUES
      ('${ids.ask}', '${sessionId}', 'user', 'Fix the bug', 'user', '{"externalUserId":"ada"}', 'next_turn', '{}'),
      ('${ids.reply}', '${sessionId}', 'assistant', 'Fixed it', 'agent', '{"sessionId":"${sessionId}","agentId":null}', 'next_turn',
        '{"status":"completed","changedFiles":[{"path":"src/a.ts","kind":"modified"}],"events":[{"type":"command","content":"bun test"},{"type":"file_edit","filePath":"src/a.ts"},{"type":"text","content":"Fixed it"}]}'),
      ('${ids.aside}', '${sessionId}', 'user', 'For the record', 'user', '{"externalUserId":"ada"}', 'message_only', '{}'),
      ('${ids.system}', '${sessionId}', 'system', 'Grace joined', 'system', '{}', 'message_only', '{}'),
      ('${ids.second}', '${sessionId}', 'user', 'Now the docs', 'user', '{"externalUserId":"ada"}', 'next_turn', '{"attention":"required"}'),
      ('${ids.partial}', '${sessionId}', 'assistant', 'Thinking...', 'agent', '{"sessionId":"${sessionId}","agentId":null}', 'next_turn',
        '{"status":"in_progress","partialContent":"Started on the docs"}'),
      ('${ids.queued}', '${sessionId}', 'user', 'Then the tests', 'user', '{"externalUserId":"ada"}', 'next_turn', '{}'),
      ('${ids.builtInAsk}', '${builtInSessionId}', 'user', 'Hello', 'user', '{"externalUserId":"ada"}', 'next_turn', '{}'),
      ('${ids.builtInReply}', '${builtInSessionId}', 'assistant', 'Hi', 'agent', '{"sessionId":"${builtInSessionId}","agentId":null}', 'next_turn', '{"status":"completed"}')`);
    await run(`INSERT INTO agent_turns (id, session_id, message_id, result_message_id, status, delivery_mode, attempt, created_at) VALUES
      ('${ids.turnOne}', '${sessionId}', '${ids.ask}', '${ids.reply}', 'completed', 'next_turn', 1, now() - interval '1 minute'),
      ('${ids.turnTwo}', '${sessionId}', '${ids.second}', '${ids.partial}', 'running', 'next_turn', 1, now()),
      ('${ids.turnThree}', '${sessionId}', '${ids.queued}', NULL, 'queued', 'next_turn', 0, now() + interval '1 second'),
      ('${ids.builtInTurn}', '${builtInSessionId}', '${ids.builtInAsk}', '${ids.builtInReply}', 'completed', 'next_turn', 1, now())`);

    // Now 045.
    await run(
      `DELETE FROM _migrations WHERE name = '045_agent_session_log.sql'`,
    );
    const result = await migrateToLatest({ db, schema });
    expect(result.applied).toEqual(["045_agent_session_log.sql"]);

    const items = await run(
      `SELECT id, kind, status, text, turn_id, position, payload FROM agent_items WHERE session_id = '${sessionId}' ORDER BY position`,
    );
    const rows = items.rows as Array<{
      id: string;
      kind: string;
      status: string;
      text: string;
      turn_id: string | null;
      position: string | number;
      payload: Record<string, unknown>;
    }>;
    expect(rows.map((row) => [row.kind, row.status, row.text])).toEqual([
      ["user_message", "completed", "Fix the bug"],
      ["command", "completed", "bun test"],
      ["file_change", "completed", ""],
      ["assistant_message", "completed", "Fixed it"],
      ["user_message", "completed", "For the record"],
      ["user_message", "completed", "Grace joined"],
      ["user_message", "completed", "Now the docs"],
      ["assistant_message", "failed", "Started on the docs"],
      ["user_message", "completed", "Then the tests"],
    ]);
    // A turn holds its input and the agent's output for it; messages sent
    // outside a turn belong to none, so they never read as steers.
    expect(rows.map((row) => row.turn_id)).toEqual([
      ids.turnOne,
      ids.turnOne,
      ids.turnOne,
      ids.turnOne,
      null,
      null,
      ids.turnTwo,
      ids.turnTwo,
      ids.turnThree,
    ]);
    for (const row of rows)
      expect(row.payload).toMatchObject({
        id: row.id,
        sessionId,
        kind: row.kind,
        position: Number(row.position),
      });
    expect(rows[6]?.payload).toMatchObject({
      author: { kind: "user", externalUserId: "ada" },
      dispatch: "queue",
      attention: "required",
    });

    const turns = await run(
      `SELECT turn.id, turn.ordinal, turn.status, turn.error, turn.outcome, turn.completed_at,
              turn.attempt_count, thread.harness AS thread_harness
         FROM agent_turns turn
         LEFT JOIN agent_provider_threads thread ON thread.id = turn.provider_thread_id
        WHERE turn.session_id = '${sessionId}' ORDER BY turn.ordinal`,
    );
    expect(turns.rows).toMatchObject([
      {
        id: ids.turnOne,
        ordinal: 1,
        status: "completed",
        outcome: { changedFiles: [{ path: "src/a.ts", kind: "modified" }] },
        attempt_count: 1,
        thread_harness: "claude-code",
      },
      {
        id: ids.turnTwo,
        ordinal: 2,
        status: "interrupted",
        error: {
          message:
            "This turn stopped before it finished, when Work was updated.",
        },
        attempt_count: 1,
        thread_harness: "claude-code",
      },
      // Never run: no attempt, so an interrupt leaves it queued; no thread yet.
      {
        id: ids.turnThree,
        ordinal: 3,
        status: "queued",
        completed_at: null,
        attempt_count: 0,
        thread_harness: null,
      },
    ]);
    const attempts = await run(
      `SELECT count(*)::int AS count FROM agent_turn_attempts`,
    );
    expect(attempts.rows).toEqual([{ count: 0 }]);

    // A native conversation from before the log was never stored, the
    // built-in agent's included: its thread is unavailable, so the next
    // turn starts a fresh thread handed every converted turn (ADR 0197).
    const threads = await run(
      `SELECT session_id, harness, native_ref, status, last_turn_ordinal
         FROM agent_provider_threads ORDER BY harness`,
    );
    expect(threads.rows).toEqual([
      {
        session_id: builtInSessionId,
        harness: "ai-sdk",
        native_ref: null,
        status: "unavailable",
        last_turn_ordinal: 1,
      },
      {
        session_id: sessionId,
        harness: "claude-code",
        native_ref: null,
        status: "unavailable",
        last_turn_ordinal: 2,
      },
    ]);
    const builtIn = await run(
      `SELECT kind, turn_id FROM agent_items WHERE session_id = '${builtInSessionId}' ORDER BY position`,
    );
    expect(builtIn.rows).toEqual([
      { kind: "user_message", turn_id: ids.builtInTurn },
      { kind: "assistant_message", turn_id: ids.builtInTurn },
    ]);
    const session = await run(
      `SELECT event_sequence FROM agent_sessions WHERE id = '${sessionId}'`,
    );
    expect(
      Number((session.rows[0] as { event_sequence: string }).event_sequence),
    ).toBe(9);
    const old = await run(
      `SELECT to_regclass('agent_messages') AS messages, to_regclass('agent_runtime_events') AS events`,
    );
    expect(old.rows).toEqual([{ messages: null, events: null }]);
  });
});
