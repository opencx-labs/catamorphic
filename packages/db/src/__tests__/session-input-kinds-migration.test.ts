import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { Kysely, PGliteDialect, sql } from "kysely";
import { afterAll, describe, expect, it } from "vitest";
import { migrateToLatest } from "../migrate.js";

/*
 * Migration 061 (ADR 0217): only people's inputs stay user messages. An
 * agent's or a workflow's (a watcher's was a workflow's) become inbound
 * messages; Work's reports on background commands, watches, followed chats
 * and subsessions become task notifications; any other line Work wrote
 * becomes a notice. Mailbox deliveries carry the input they become.
 */

const schema = "session_input_kinds_migration";
const FROM_061 = fs
  .readdirSync(path.join(import.meta.dirname, "../../migrations"))
  .filter((name) => name.endsWith(".sql") && name >= "061")
  .sort();
const pglite = new PGlite({ extensions: { pgcrypto } });
const db = new Kysely<unknown>({ dialect: new PGliteDialect({ pglite }) });

afterAll(async () => {
  await db.destroy();
});

const tenantId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const sessionId = "33333333-3333-4333-8333-333333333333";

/** An input as the old schema held it: a user_message with an author. */
function oldInput(input: {
  id: string;
  position: number;
  author: Record<string, unknown>;
  text: string;
  dispatch?: string;
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
}): string {
  const payload = {
    id: input.id,
    sessionId,
    turnId: null,
    attemptId: null,
    parentItemId: null,
    position: input.position,
    status: "completed",
    nativeRef: null,
    createdAt: "2026-10-01T10:00:00.000Z",
    updatedAt: "2026-10-01T10:00:00.000Z",
    startedAt: null,
    endedAt: null,
    kind: "user_message",
    author: input.author,
    text: input.text,
    attachments: [],
    dispatch: input.dispatch ?? "queue",
    attention: null,
    idempotencyKey: input.idempotencyKey ?? null,
    metadata: input.metadata ?? {},
  };
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  return `(${quote(input.id)}, ${quote(sessionId)}, ${input.position}, 'user_message', 'completed', ${quote(input.text)},
    ${quote(String(input.author.kind))}, ${quote(JSON.stringify(input.author))}, ${quote(input.dispatch ?? "queue")},
    ${input.idempotencyKey ? quote(input.idempotencyKey) : "NULL"}, ${quote(JSON.stringify(payload))})`;
}

describe("migration 061", () => {
  it("types every existing input by who wrote it", {
    timeout: 120_000,
  }, async () => {
    await sql.raw(`CREATE SCHEMA IF NOT EXISTS ${schema}`).execute(db);
    await pglite.exec(
      `CREATE TABLE ${schema}._migrations (id SERIAL PRIMARY KEY, name VARCHAR(255) NOT NULL UNIQUE, applied_at TIMESTAMPTZ NOT NULL DEFAULT now());
       INSERT INTO ${schema}._migrations (name) VALUES ${FROM_061.map((name) => `('${name}')`).join(", ")};`,
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
    await run(`INSERT INTO agent_sessions (id, project_id, external_user_id)
               VALUES ('${sessionId}', '${projectId}', 'ada')`);
    const rows = [
      oldInput({
        id: "44444444-4444-4444-8444-444444444441",
        position: 1,
        author: { kind: "user", externalUserId: "ada" },
        text: "Fix the bug",
      }),
      oldInput({
        id: "44444444-4444-4444-8444-444444444442",
        position: 2,
        author: { kind: "workflow", runId: "run-1", workflowName: "prReview" },
        text: "Review PR #12",
      }),
      oldInput({
        id: "44444444-4444-4444-8444-444444444443",
        position: 3,
        author: { kind: "agent", sessionId: "other", agentId: null },
        text: "The tests pass now",
        dispatch: "steer",
      }),
      oldInput({
        id: "44444444-4444-4444-8444-444444444444",
        position: 4,
        author: { kind: "watcher", watcherId: "watcher-1" },
        text: "Checks passed",
      }),
      oldInput({
        id: "44444444-4444-4444-8444-444444444445",
        position: 5,
        author: { kind: "system", code: "background_command" },
        text: "Background command cmd-1 (Build) failed with exit code 1.\nCommand: bun run build",
        idempotencyKey: "background:cmd-1:exit",
        metadata: { notice: "Build failed (exit 1)" },
      }),
      oldInput({
        id: "44444444-4444-4444-8444-444444444446",
        position: 6,
        author: { kind: "system", code: "subsession_archived" },
        text: "Subsession child-1 was archived by the user.",
        idempotencyKey: "delegation:d-1:archived",
      }),
      oldInput({
        id: "44444444-4444-4444-8444-444444444447",
        position: 7,
        author: { kind: "system" },
        text: "Grace joined",
        dispatch: "message_only",
      }),
    ];
    await run(`INSERT INTO agent_items (id, session_id, position, kind, status, text, author_kind, author_payload, dispatch, idempotency_key, payload)
               VALUES ${rows.join(",\n")}`);
    await run(`INSERT INTO session_mailbox_items (project_id, session_id, source_host_id, destination_host_id,
                 authority_revision, content, author_kind, author_payload, delivery_mode)
               VALUES ('${projectId}', '${sessionId}', 'server', 'desktop', 1, 'Deploy is done', 'workflow',
                 '{"kind":"workflow","runId":"run-2","workflowName":"deploys"}', 'queue')`);

    await run(
      `DELETE FROM _migrations WHERE name IN (${FROM_061.map((name) => `'${name}'`).join(", ")})`,
    );
    await migrateToLatest({ db, schema });

    const items = (
      await run(
        `SELECT kind, author_kind, text, payload FROM agent_items WHERE session_id = '${sessionId}' ORDER BY position`,
      )
    ).rows as Array<{
      kind: string;
      author_kind: string | null;
      text: string;
      payload: Record<string, unknown>;
    }>;
    expect(items.map((item) => [item.kind, item.payload.kind])).toEqual([
      ["user_message", "user_message"],
      ["inbound_message", "inbound_message"],
      ["inbound_message", "inbound_message"],
      ["inbound_message", "inbound_message"],
      ["task_notification", "task_notification"],
      ["task_notification", "task_notification"],
      ["notice", "notice"],
    ]);
    expect(items[0]?.payload.author).toEqual({
      kind: "user",
      externalUserId: "ada",
    });
    expect(items[1]?.payload).toMatchObject({
      from: { kind: "workflow", runId: "run-1", workflowName: "prReview" },
      text: "Review PR #12",
      dispatch: "queue",
    });
    expect(items[1]?.payload).not.toHaveProperty("author");
    expect(items[2]?.payload).toMatchObject({
      from: { kind: "agent", sessionId: "other" },
      dispatch: "steer",
    });
    // A watcher's delivery was its workflow's.
    expect(items[3]).toMatchObject({
      author_kind: "workflow",
      payload: { from: { kind: "workflow", workflowName: "watcher-1" } },
    });
    expect(items[4]).toMatchObject({
      text: "Build failed (exit 1)",
      payload: {
        task: {
          type: "background_command",
          id: "cmd-1",
          title: "Build failed (exit 1)",
          status: "failed",
        },
        summary: "Build failed (exit 1)",
        detail:
          "Background command cmd-1 (Build) failed with exit code 1.\nCommand: bun run build",
        source: null,
      },
    });
    expect(items[5]?.payload).toMatchObject({
      task: { type: "subsession", id: "d-1", status: "stopped" },
      summary: "Subsession child-1 was archived by the user.",
    });
    expect(items[6]?.payload).toMatchObject({
      code: "system_message",
      text: "Grace joined",
      data: {},
    });
    expect(items[6]?.payload).not.toHaveProperty("author");

    const mailbox = (
      await run(
        `SELECT * FROM session_mailbox_items WHERE session_id = '${sessionId}'`,
      )
    ).rows as Array<Record<string, unknown>>;
    expect(mailbox[0]?.input).toEqual({
      kind: "inbound_message",
      from: { kind: "workflow", runId: "run-2", workflowName: "deploys" },
      text: "Deploy is done",
      attachments: [],
    });
    expect(mailbox[0]).not.toHaveProperty("content");
    expect(mailbox[0]).not.toHaveProperty("author_kind");
  });
});
