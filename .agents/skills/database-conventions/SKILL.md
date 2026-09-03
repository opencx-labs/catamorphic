---
name: database-conventions
description: Use when changing Catamorphic database connections, schemas, migrations, Kysely queries, migration execution, or generated database types.
---

# Database Conventions

## Stack

- **PostgreSQL 17** via Docker Compose (local dev); the host's Postgres in production
- **Kysely** for type-safe SQL queries
- **kysely-codegen** generates TypeScript types from the live database schema

Catamorphic always lives in its own `catamorphic` schema (hosts mount it inside their own database). The `db:codegen` script in [packages/db/package.json](../../../packages/db/package.json) passes `--include-pattern 'catamorphic.*' --default-schema=catamorphic` so the generated `DB` type is scoped to Catamorphic tables only and uses bare names (`projects`, `tenants`, …), independent of whatever else lives in the target database. Do not remove those flags — running codegen against a host DB without them will generate unqualified names for host tables and schema-qualified names for Catamorphic tables, breaking every query in `@catamorphic/core`.

## Connection

Two supported shapes (see `docs/decisions/0003`):

```typescript
import { createDatabase } from "@catamorphic/db";

// Catamorphic-owned pool from a connection string; sets search_path.
const db = createDatabase({
  connectionString: process.env.DATABASE_URL!,
  schema: "catamorphic",
});

// Host-owned pg.Pool; queries are schema-qualified via WithSchemaPlugin,
// the pool's own search_path is never touched.
const db2 = createDatabase({ pool: hostPgPool });
```

Default local dev URL: `postgresql://catamorphic:catamorphic@localhost:5432/catamorphic`.

## Migrations

Forward-only raw SQL in `packages/db/migrations/`, numbered sequentially (e.g. `002_projects.sql`, `007_plugins_and_secrets.sql`). To undo something, write a new forward migration. Never write down migrations.

Migrations run inside the target schema (`SET LOCAL search_path`) and are tracked in `<schema>._migrations`. They're runnable via the `catamorphic-db` CLI or programmatically:

```typescript
import { createDatabase, migrateToLatest } from "@catamorphic/db";

await migrateToLatest({ db, schema: "catamorphic" });
```

## Adding a New Table

1. Create a new `.sql` file in `packages/db/migrations/`
2. Run migrations and regenerate types:

```bash
bun run db:migrate
bun run db:codegen
```

3. Commit the updated `packages/db/src/generated/db.ts` with the migration. This generated source is tracked; rerunning `bun run db:codegen` against an up-to-date local database must leave it unchanged.
4. Use it in Kysely queries with full type safety

## Current table groups

- Project/host integration: `tenants`, `projects`, `project_plugins`,
  `project_secrets`, `project_sandboxes`, `agent_sessions`, `agent_messages`.
- Deployment/runtime: `deployment_artifacts`, `deployment_runtimes`,
  `execution_jobs`, `rate_reservation_buckets`.
- Canonical Runs: `workflow_runs`, `workflow_run_states`,
  `workflow_step_attempts`, `workflow_pauses`, `workflow_run_events`,
  `workflow_run_steps`.
- Batch-scope extensions: `batch_execution_states`, `batch_items`,
  `batch_step_invocations`, `batch_step_members`, `batch_item_steps`,
  `batch_sink_chunks`.

There is **no** `workflows` table: Workflows are discovered from project source
and identified by `(projectId, workflowName)`. Every invocation uses
`workflow_runs`; capability-specific state is keyed by Run and workflow-step
attempt rather than a separate Run table.

Workflow-woken conversations use `agent_sessions.wake_key` with one partial
unique index over active `(project_id, external_user_id, wake_key)` rows.
Attention is a monotonic revision pair on that same session, not a notification
inbox table: settlement increments `attention_revision`; opening copies it to
`attention_seen_revision`. Preserve the check that seen never exceeds current
and do both mutations atomically in SQL.

## Querying

```typescript
import type { DB } from "@catamorphic/db";
import type { Selectable } from "kysely";

const runs = await db
  .selectFrom("workflow_runs")
  .where("project_id", "=", projectId)
  .selectAll()
  .execute();
// row type: Selectable<DB["workflow_runs"]>
```
