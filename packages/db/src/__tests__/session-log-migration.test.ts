import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { Kysely, PGliteDialect, sql } from "kysely";
import { afterAll, describe, expect, it } from "vitest";
import { migrateToLatest } from "../migrate.js";

/*
 * Migration 045 turns existing chats into the session log (ADR 0196):
 * messages become items in order, step logs become work items, turns keep
 * their outcome, a turn caught running reads as interrupted, and the log
 * continues after the converted history.
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
const ids = {
  ask: "44444444-4444-4444-8444-444444444441",
  reply: "44444444-4444-4444-8444-444444444442",
  second: "44444444-4444-4444-8444-444444444443",
  partial: "44444444-4444-4444-8444-444444444444",
  turnOne: "55555555-5555-4555-8555-555555555551",
  turnTwo: "55555555-5555-4555-8555-555555555552",
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
               VALUES ('${sessionId}', '${projectId}', 'ada', 'claude-code', 'native-1')`);
    await run(`INSERT INTO agent_messages (id, session_id, role, content, author_kind, author_payload, delivery_mode, metadata) VALUES
      ('${ids.ask}', '${sessionId}', 'user', 'Fix the bug', 'user', '{"externalUserId":"ada"}', 'next_turn', '{}'),
      ('${ids.reply}', '${sessionId}', 'assistant', 'Fixed it', 'agent', '{"sessionId":"${sessionId}","agentId":null}', 'next_turn',
        '{"status":"completed","changedFiles":[{"path":"src/a.ts","kind":"modified"}],"events":[{"type":"command","content":"bun test"},{"type":"file_edit","filePath":"src/a.ts"},{"type":"text","content":"Fixed it"}]}'),
      ('${ids.second}', '${sessionId}', 'user', 'Now the docs', 'user', '{"externalUserId":"ada"}', 'next_turn', '{"attention":"required"}'),
      ('${ids.partial}', '${sessionId}', 'assistant', 'Thinking...', 'agent', '{"sessionId":"${sessionId}","agentId":null}', 'next_turn',
        '{"status":"in_progress","partialContent":"Started on the docs"}')`);
    await run(`INSERT INTO agent_turns (id, session_id, message_id, result_message_id, status, delivery_mode, created_at) VALUES
      ('${ids.turnOne}', '${sessionId}', '${ids.ask}', '${ids.reply}', 'completed', 'next_turn', now() - interval '1 minute'),
      ('${ids.turnTwo}', '${sessionId}', '${ids.second}', '${ids.partial}', 'running', 'next_turn', now())`);

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
      ["user_message", "completed", "Now the docs"],
      ["assistant_message", "failed", "Started on the docs"],
    ]);
    // Each item belongs to the turn its input started; payloads are whole items.
    expect(rows.map((row) => row.turn_id)).toEqual([
      ids.turnOne,
      ids.turnOne,
      ids.turnOne,
      ids.turnOne,
      ids.turnTwo,
      ids.turnTwo,
    ]);
    for (const row of rows)
      expect(row.payload).toMatchObject({
        id: row.id,
        sessionId,
        kind: row.kind,
        position: Number(row.position),
      });
    expect(rows[4]?.payload).toMatchObject({
      author: { kind: "user", externalUserId: "ada" },
      dispatch: "queue",
      attention: "required",
    });

    const turns = await run(
      `SELECT id, ordinal, status, error, outcome, completed_at FROM agent_turns WHERE session_id = '${sessionId}' ORDER BY ordinal`,
    );
    expect(turns.rows).toMatchObject([
      {
        id: ids.turnOne,
        ordinal: 1,
        status: "completed",
        outcome: { changedFiles: [{ path: "src/a.ts", kind: "modified" }] },
      },
      {
        id: ids.turnTwo,
        ordinal: 2,
        status: "interrupted",
        error: {
          message:
            "This turn stopped before it finished, when Work was updated.",
        },
      },
    ]);

    // The native conversation carries over, and the log continues after the history.
    const thread = await run(
      `SELECT harness, native_ref FROM agent_provider_threads WHERE session_id = '${sessionId}'`,
    );
    expect(thread.rows).toEqual([
      {
        harness: "claude-code",
        native_ref: { id: "native-1", strength: "strong" },
      },
    ]);
    const session = await run(
      `SELECT event_sequence FROM agent_sessions WHERE id = '${sessionId}'`,
    );
    expect(
      Number((session.rows[0] as { event_sequence: string }).event_sequence),
    ).toBe(6);
    const old = await run(
      `SELECT to_regclass('agent_messages') AS messages, to_regclass('agent_runtime_events') AS events`,
    );
    expect(old.rows).toEqual([{ messages: null, events: null }]);
  });
});
