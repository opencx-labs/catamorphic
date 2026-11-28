import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { Kysely, PGliteDialect, sql } from "kysely";
import { afterAll, describe, expect, it } from "vitest";
import { migrateToLatest } from "../migrate.js";

/*
 * Migration 098 (ADR 0355): a revision's deploy is an event workflows bind,
 * so a published revision keeps the event and its listeners' runs where it
 * kept one workflow, enablement and run. A deploy the manifest named keeps
 * the run it started: one under way while the migration runs is still
 * waited for, and one that had started no run starts over instead of going
 * live with nothing to wait for.
 */

const schema = "deploy_listeners_migration";
const FROM_098 = fs
  .readdirSync(path.join(import.meta.dirname, "../../migrations"))
  .filter((name) => name.endsWith(".sql") && name >= "098")
  .sort();
const pglite = new PGlite({ extensions: { pgcrypto } });
const db = new Kysely<unknown>({ dialect: new PGliteDialect({ pglite }) });

afterAll(async () => {
  await db.destroy();
});

const tenantId = "11111111-1111-4111-8111-111111111111";
const projects = [
  "22222222-2222-4222-8222-222222222221",
  "22222222-2222-4222-8222-222222222222",
];
const enablementId = "33333333-3333-4333-8333-333333333333";
const runs = [
  "44444444-4444-4444-8444-444444444441",
  "44444444-4444-4444-8444-444444444442",
];
const sha = (letter: string) => letter.repeat(40);

describe("migration 098", () => {
  it("keeps the run of a deploy the manifest named, and starts one over that had none", {
    timeout: 120_000,
  }, async () => {
    await sql.raw(`CREATE SCHEMA IF NOT EXISTS ${schema}`).execute(db);
    await pglite.exec(
      `CREATE TABLE ${schema}._migrations (id SERIAL PRIMARY KEY, name VARCHAR(255) NOT NULL UNIQUE, applied_at TIMESTAMPTZ NOT NULL DEFAULT now());
       INSERT INTO ${schema}._migrations (name) VALUES ${FROM_098.map((name) => `('${name}')`).join(", ")};`,
    );
    await migrateToLatest({ db, schema });
    const run = async (statement: string) => {
      await pglite.exec(`SET search_path TO ${schema}`);
      return pglite.query<Record<string, unknown>>(statement);
    };
    await run(`INSERT INTO tenants (id, name) VALUES ('${tenantId}', 'T')`);
    for (const projectId of projects)
      await run(
        `INSERT INTO projects (id, tenant_id, name) VALUES ('${projectId}', '${tenantId}', 'P')`,
      );
    // The rows as 097 kept them. Only the revisions matter here, so the
    // enablement and runs they name are not made.
    await pglite.exec(`SET session_replication_role = replica`);
    await run(`INSERT INTO published_revisions
        (tenant_id, project_id, commit_sha, status, deploy_workflow,
         deploy_enablement_id, deploy_run_id, deploy_started_at, error, settled_at)
      VALUES
        ('${tenantId}', '${projects[0]}', '${sha("a")}', 'applied', NULL, NULL, NULL, NULL, NULL, now()),
        ('${tenantId}', '${projects[0]}', '${sha("b")}', 'failed', 'migrate',
         '${enablementId}', '${runs[0]}', now(), 'The deploy workflow migrate failed', now()),
        ('${tenantId}', '${projects[0]}', '${sha("c")}', 'deploying', 'migrate',
         '${enablementId}', '${runs[1]}', now(), NULL, NULL),
        ('${tenantId}', '${projects[1]}', '${sha("d")}', 'deploying', 'migrate',
         '${enablementId}', NULL, now(), NULL, NULL)`);
    await pglite.exec(`SET session_replication_role = DEFAULT`);

    await run(
      `DELETE FROM _migrations WHERE name IN (${FROM_098.map((name) => `'${name}'`).join(", ")})`,
    );
    await migrateToLatest({ db, schema });

    const { rows } = await run(
      `SELECT commit_sha, status, deploy_event_id, deploy_listeners, deploy_started_at IS NULL AS unstarted, error
       FROM published_revisions ORDER BY sequence`,
    );
    const listener = (runId: string) => [
      { enablementId, workflowName: "migrate", runId },
    ];
    expect(rows).toEqual([
      {
        commit_sha: sha("a"),
        status: "applied",
        deploy_event_id: null,
        deploy_listeners: [],
        unstarted: true,
        error: null,
      },
      // A past deploy still reports the run it started.
      {
        commit_sha: sha("b"),
        status: "failed",
        deploy_event_id: null,
        deploy_listeners: listener(runs[0] ?? ""),
        unstarted: false,
        error: "The deploy workflow migrate failed",
      },
      // One under way is still waited for.
      {
        commit_sha: sha("c"),
        status: "deploying",
        deploy_event_id: null,
        deploy_listeners: listener(runs[1] ?? ""),
        unstarted: false,
        error: null,
      },
      // One that had started no run starts over.
      {
        commit_sha: sha("d"),
        status: "pending",
        deploy_event_id: null,
        deploy_listeners: [],
        unstarted: true,
        error: null,
      },
    ]);
    const columns = await run(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = '${schema}' AND table_name = 'published_revisions'
         AND column_name LIKE 'deploy_%' ORDER BY column_name`,
    );
    expect(columns.rows.map((row) => row.column_name)).toEqual([
      "deploy_attempt",
      "deploy_event_id",
      "deploy_listeners",
      "deploy_noticed",
      "deploy_started_at",
    ]);
  });
});
