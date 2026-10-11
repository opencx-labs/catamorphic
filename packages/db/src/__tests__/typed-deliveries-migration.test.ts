import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { Kysely, PGliteDialect, sql } from "kysely";
import { afterAll, describe, expect, it } from "vitest";
import { migrateToLatest } from "../migrate.js";

/*
 * Migration 062 (ADR 0219): an input's metadata becomes fields of its own.
 * Who delivered it and the enablements behind it are delivery fields; a
 * person's answer carries its questions; a workflow sender carries its
 * run's enablement, watcher and schedule, and its message the alert it
 * asked for. The events that logged an input carry it the same way. A
 * mailbox row is an input or a session action, with what its destination
 * acts on as columns.
 */

const schema = "typed_deliveries_migration";
const FROM_062 = fs
  .readdirSync(path.join(import.meta.dirname, "../../migrations"))
  .filter((name) => name.endsWith(".sql") && name >= "062")
  .sort();
const pglite = new PGlite({ extensions: { pgcrypto } });
const db = new Kysely<unknown>({ dialect: new PGliteDialect({ pglite }) });

afterAll(async () => {
  await db.destroy();
});

const tenantId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const sessionId = "33333333-3333-4333-8333-333333333333";
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;

/** An input as 061 left it: its delivery facts in `metadata`. */
function input(row: {
  id: string;
  position: number;
  kind: "user_message" | "inbound_message" | "task_notification";
  fields: Record<string, unknown>;
  authorKind: string | null;
  author: Record<string, unknown> | null;
  metadata: Record<string, unknown>;
}): string {
  const payload = {
    id: row.id,
    sessionId,
    turnId: null,
    attemptId: null,
    parentItemId: null,
    position: row.position,
    status: "completed",
    nativeRef: null,
    createdAt: "2026-10-01T10:00:00.000Z",
    updatedAt: "2026-10-01T10:00:00.000Z",
    startedAt: null,
    endedAt: null,
    kind: row.kind,
    ...row.fields,
    dispatch: "queue",
    attention: null,
    idempotencyKey: null,
    metadata: row.metadata,
  };
  return `(${quote(row.id)}, ${quote(sessionId)}, ${row.position}, ${quote(row.kind)}, 'completed', 'text',
    ${row.authorKind ? quote(row.authorKind) : "NULL"}, ${row.author ? quote(JSON.stringify(row.author)) : "NULL"}, 'queue',
    ${quote(JSON.stringify(payload))})`;
}

describe("migration 062", () => {
  it("gives every delivery fact a field of its own", {
    timeout: 120_000,
  }, async () => {
    await sql.raw(`CREATE SCHEMA IF NOT EXISTS ${schema}`).execute(db);
    await pglite.exec(
      `CREATE TABLE ${schema}._migrations (id SERIAL PRIMARY KEY, name VARCHAR(255) NOT NULL UNIQUE, applied_at TIMESTAMPTZ NOT NULL DEFAULT now());
       INSERT INTO ${schema}._migrations (name) VALUES ${FROM_062.map((name) => `('${name}')`).join(", ")};`,
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
    const workflow = {
      kind: "workflow",
      runId: "run-1",
      workflowName: "reminders",
    };
    const question = {
      question: "Which pages?",
      header: "Pages",
      multiSelect: false,
      options: [{ label: "New", description: "The new ones" }],
    };
    await run(`INSERT INTO agent_items (id, session_id, position, kind, status, text, author_kind, author_payload, dispatch, payload)
               VALUES ${[
                 input({
                   id: "44444444-4444-4444-8444-444444444441",
                   position: 1,
                   kind: "user_message",
                   fields: {
                     author: { kind: "user", externalUserId: "ada" },
                     text: "Which pages?\n\nUser answer:\nNew",
                     attachments: [],
                   },
                   authorKind: "user",
                   author: { kind: "user", externalUserId: "ada" },
                   metadata: {
                     deliveredBy: "ada",
                     questionRequestId: "request-1",
                     question: { questions: [question], answers: ["New", 3] },
                   },
                 }),
                 input({
                   id: "44444444-4444-4444-8444-444444444442",
                   position: 2,
                   kind: "inbound_message",
                   fields: {
                     from: workflow,
                     text: "Submit it",
                     attachments: [],
                   },
                   authorKind: "workflow",
                   author: workflow,
                   metadata: {
                     deliveredBy: "ada",
                     causation: ["enablement-1", 7],
                     provenance: {
                       projectId,
                       hostId: "desktop",
                       runId: "run-1",
                       workflowName: "reminders",
                       scheduledFor: "2026-10-01T09:00:00.000Z",
                       firedAt: "2026-10-01T10:00:00.000Z",
                       enablementId: "enablement-1",
                       watcherId: "watcher-1",
                       sessionId: "chat-1",
                     },
                     workflowNotification: { title: " ", body: "Due today" },
                   },
                 }),
                 input({
                   id: "44444444-4444-4444-8444-444444444444",
                   position: 4,
                   kind: "user_message",
                   fields: {
                     author: { kind: "user", externalUserId: "ada" },
                     text: "Which pages?\n\nUser answer:\nOld",
                     attachments: [],
                   },
                   authorKind: "user",
                   author: { kind: "user", externalUserId: "ada" },
                   metadata: { questionRequestId: "request-0" },
                 }),
                 input({
                   id: "44444444-4444-4444-8444-444444444443",
                   position: 3,
                   kind: "task_notification",
                   fields: {
                     task: {
                       type: "background_command",
                       id: "cmd-1",
                       title: "Build",
                       status: "failed",
                     },
                     summary: "Build failed",
                     detail: "",
                     source: null,
                   },
                   authorKind: "system",
                   author: { kind: "system", code: "background_command" },
                   metadata: {},
                 }),
               ].join(",\n")}`);
    await run(`INSERT INTO agent_runtime_requests (session_id, request_id, kind, created_at, payload, response, status)
               VALUES ('${sessionId}', 'request-0', 'question', now(),
                 ${quote(JSON.stringify({ id: "request-0", kind: "question", questions: [question] }))},
                 ${quote(JSON.stringify({ kind: "question", answers: ["Old"] }))}, 'resolved')`);
    // The event that logged the workflow's message, as it was then.
    const logged = (
      await run(
        `SELECT payload FROM agent_items WHERE id = '44444444-4444-4444-8444-444444444442'`,
      )
    ).rows as Array<{ payload: Record<string, unknown> }>;
    await run(`INSERT INTO agent_session_events (session_id, sequence, type, payload)
               VALUES ('${sessionId}', 1, 'item.added', ${quote(
                 JSON.stringify({
                   type: "item.added",
                   item: { ...logged[0]?.payload, status: "in_progress" },
                 }),
               )})`);
    await run(`INSERT INTO session_mailbox_items (project_id, session_id, source_host_id, destination_host_id,
                 authority_revision, input, delivery_mode, idempotency_key, metadata)
               VALUES
               ('${projectId}', '${sessionId}', 'server', 'desktop', 1,
                 ${quote(JSON.stringify({ kind: "inbound_message", from: workflow, text: "Deploy is done", attachments: [] }))},
                 'queue', 'deploy',
                 ${quote(JSON.stringify({ deliveredBy: "grace", attention: "required", ownerAuthored: true, causation: ["enablement-2"], provenance: { enablementId: "enablement-2" } }))}),
               ('${projectId}', '${sessionId}', 'server', 'desktop', 1,
                 ${quote(JSON.stringify({ kind: "user_message", author: { kind: "user", externalUserId: "grace" }, text: "Completed the work", attachments: [] }))},
                 'message_only', 'action:1',
                 ${quote(JSON.stringify({ sessionAction: { operation: "complete", args: { sessionId }, causation: ["enablement-3"], provenance: {} } }))})`);

    await run(
      `DELETE FROM _migrations WHERE name IN (${FROM_062.map((name) => `'${name}'`).join(", ")})`,
    );
    await migrateToLatest({ db, schema });

    const items = (
      await run(
        `SELECT author_payload, payload FROM agent_items WHERE session_id = '${sessionId}' ORDER BY position`,
      )
    ).rows as Array<{
      author_payload: Record<string, unknown>;
      payload: Record<string, unknown>;
    }>;
    for (const item of items)
      expect(item.payload).not.toHaveProperty("metadata");
    expect(items[0]?.payload).toMatchObject({
      deliveredBy: "ada",
      causation: [],
      answer: {
        requestId: "request-1",
        questions: [question],
        answers: ["New"],
      },
    });
    const sender = {
      ...workflow,
      enablementId: "enablement-1",
      watcher: { id: "watcher-1", sessionId: "chat-1" },
      scheduledFor: "2026-10-01T09:00:00.000Z",
      firedAt: "2026-10-01T10:00:00.000Z",
    };
    expect(items[1]?.payload).toMatchObject({
      from: sender,
      deliveredBy: "ada",
      causation: ["enablement-1"],
      alert: { body: "Due today" },
    });
    expect(items[1]?.payload.alert).toEqual({ body: "Due today" });
    expect(items[1]?.author_payload).toEqual(sender);
    expect(items[2]?.payload).toMatchObject({
      deliveredBy: null,
      causation: [],
    });
    // An answer from before answers carried their questions takes them
    // from the request it answered.
    expect(items[3]?.payload).toMatchObject({
      answer: {
        requestId: "request-0",
        questions: [question],
        answers: ["Old"],
      },
    });
    const events = (
      await run(
        `SELECT payload FROM agent_session_events WHERE session_id = '${sessionId}'`,
      )
    ).rows as Array<{ payload: { item: Record<string, unknown> } }>;
    expect(events[0]?.payload.item).not.toHaveProperty("metadata");
    expect(events[0]?.payload.item).toMatchObject({
      from: sender,
      deliveredBy: "ada",
      causation: ["enablement-1"],
      status: "in_progress",
    });

    const mailbox = (
      await run(
        `SELECT * FROM session_mailbox_items WHERE session_id = '${sessionId}' ORDER BY idempotency_key DESC`,
      )
    ).rows as Array<Record<string, unknown>>;
    expect(mailbox[0]).toMatchObject({
      kind: "input",
      input: {
        kind: "inbound_message",
        from: { ...workflow, enablementId: "enablement-2" },
      },
      delivery_mode: "queue",
      attention: true,
      delivered_by: "grace",
      owner_authored: true,
      causation: ["enablement-2"],
      action: null,
    });
    expect(mailbox[0]).not.toHaveProperty("metadata");
    expect(mailbox[1]).toMatchObject({
      kind: "action",
      input: null,
      delivery_mode: null,
      action: {
        operation: "complete",
        args: { sessionId },
        actor: { kind: "user", externalUserId: "grace" },
      },
      causation: ["enablement-3"],
      owner_authored: false,
    });
    // A row is an input or an action, never both or neither, and an action
    // carries nothing only an input means.
    await expect(
      run(
        `UPDATE session_mailbox_items SET input = '{}'::jsonb WHERE kind = 'action'`,
      ),
    ).rejects.toThrow(/chk_session_mailbox_delivery/);
    await expect(
      run(
        `UPDATE session_mailbox_items SET owner_authored = true WHERE kind = 'action'`,
      ),
    ).rejects.toThrow(/chk_session_mailbox_delivery/);
  });
});
