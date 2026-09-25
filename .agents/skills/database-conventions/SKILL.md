---
name: database-conventions
description: Use when changing Catamorphic's database schema, migrations, generated Kysely types, raw SQL, database connection setup, or Postgres-based coordination such as queues, leases, and locks.
---

# Database conventions

Catamorphic keeps all durable state in Postgres through Kysely, inside its own
schema (default `catamorphic`) in the host's database
([ADR 0003](../../../docs/decisions/0003-postgres-schema-scoped-storage.md)).
It never references host tables and has no cross-schema foreign keys. Queues,
schedules, and leases are built on the same Postgres (`FOR UPDATE SKIP LOCKED`,
advisory locks), not on new infrastructure.

Every change must work on both backends: network Postgres (17 in the dev
`docker-compose.yml`) and PGlite, which the desktop and standalone stock server
use. PGlite is never a shared cluster database; multi-instance deployments use
network Postgres with claims, leases, and fencing
([ADR 0099](../../../docs/decisions/0099-shared-postgres-server-environments.md)).

## Connections

Hosts pass one of three shapes to `createCatamorphic({ database })`:

| Shape | Scoping | Owner |
| --- | --- | --- |
| `{ connectionString, schema? }` | `search_path` set on every connection | Catamorphic; closed by `close()` |
| `{ pool, schema? }` | `WithSchemaPlugin` qualifies queries | Host |
| `{ db, schema? }` | Must arrive already scoped | Host |

`createDatabase` from `@catamorphic/db` builds the first two. The desktop uses
the third: a `PGliteDialect` Kysely with `WithSchemaPlugin`, plus a session-wide
`SET search_path` ([boot.ts](../../../apps/desktop/src/main/server/boot.ts)).

## Queries

Use the query builder with the generated `DB` type; row types are
`Selectable<DB["table"]>`.

```typescript
const runs = await db
  .selectFrom("workflow_runs")
  .where("project_id", "=", projectId)
  .selectAll()
  .execute();
```

`WithSchemaPlugin` qualifies builder queries only. In a raw `sql` template, do
not name a table bare, since a host-owned pool never has Catamorphic's
`search_path`. Embed a builder fragment so the plugin qualifies it:

```typescript
sql`SELECT job.id FROM (${trx.selectFrom("execution_jobs").selectAll()}) AS job
    WHERE job.status = 'pending' FOR UPDATE OF job SKIP LOCKED`;
```

## Migrations

Forward-only raw SQL in `packages/db/migrations/`, named with the next
three-digit number and a snake_case summary (`020_example_change.sql`).
`001_initial.sql` is the squashed baseline. No down migrations.

- Write migrations schema-agnostic: no schema prefixes. `migrateToLatest` sets
  the target `search_path`, holds a database-wide advisory lock, and applies all
  pending files in one transaction. It records each file by name in
  `<schema>._migrations`.
- They must run on PGlite: statements are split one at a time, and only the
  `pgcrypto` extension is loaded.
- The project is greenfield. Rename, drop, and backfill in place, with no
  compatibility columns or shims (see `019_project_automations.sql`).
- A migration that has reached `main` has run against durable dev profiles and
  is never rerun, so change the schema with a new file. A migration that exists
  only in your unmerged branch may be rewritten in place.

Migrations run on boot (`catamorphic.migrate()` or `migrateToLatest`) and
through the `catamorphic-db` CLI (`migrate`, `status`, `reset`).

## Changing the schema

1. Add the migration.
2. Update the applied list and the base-table count in
   [pglite-migrations.test.ts](../../../packages/db/src/__tests__/pglite-migrations.test.ts).
3. Regenerate types against a migrated Postgres at `DATABASE_URL` (default
   `postgresql://catamorphic:catamorphic@localhost:5432/catamorphic`, from
   `docker compose up -d postgres`):

   ```bash
   bun run db:migrate && bun run db:codegen
   ```

   The compose database is shared across worktrees. If it holds another
   branch's migrations, point `DATABASE_URL` at a fresh database.
4. Commit `packages/db/src/generated/db.ts` with the migration. `bun run check`
   migrates a disposable database, reruns codegen, and fails on any diff.

Keep the codegen flags in `packages/db/package.json`
(`--include-pattern 'catamorphic.*' --default-schema=catamorphic`). Without them,
codegen against a shared database emits host tables and schema-qualified
Catamorphic names, which breaks every query in core.

## Invariants the schema encodes

Read [db.ts](../../../packages/db/src/generated/db.ts) for the current tables.
Rules that are easy to break:

- There is no `workflows` table. Workflows are found in project source and
  identified by `(project_id, workflow_name)`. Every invocation is a
  `workflow_runs` row, and capability state (pauses, batch items, step attempts)
  is keyed by run and step attempt.
- A chat a workflow names by key uses `agent_sessions.chat_key`, unique among
  active sessions per `(project_id, external_user_id, chat_key)`.
- Attention is a revision pair on `agent_sessions`: settling increments
  `attention_revision`, opening copies it to `attention_seen_revision`. A check
  keeps seen at or below current; do each update atomically in SQL.
- Session hierarchy (`parent_session_id`), fork lineage
  (`forked_from_session_id`), and delegation (`agent_delegations`) are separate
  relationships. Cross-host and cross-session delivery goes through
  `session_mailbox_items` and authority fencing, never direct callbacks.
- Workspace budgets live on `worker_nodes` and reservations on
  `execution_allocations` ([ADR 0100](../../../docs/decisions/0100-workspace-resource-admission.md)).
  Lock the node row before checking reservations and inserting an allocation in
  the same transaction. `status = 'released'` retires the work;
  `capacity_released_at` confirms teardown. Never reclaim capacity from an
  expired lease alone.
