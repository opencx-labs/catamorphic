# Database Conventions

## Stack

- **PostgreSQL 17** via Docker Compose (local dev); the host's Postgres in production
- **Kysely** for type-safe SQL queries
- **kysely-codegen** generates TypeScript types from the live database schema

Catamorphic always lives in its own `catamorphic` schema (hosts mount it inside their own database). The `db:codegen` script in [packages/db/package.json](../../packages/db/package.json) passes `--include-pattern 'catamorphic.*' --default-schema=catamorphic` so the generated `DB` type is scoped to Catamorphic tables only and uses bare names (`projects`, `tenants`, …), independent of whatever else lives in the target database. Do not remove those flags — running codegen against a host DB without them will generate unqualified names for host tables and schema-qualified names for Catamorphic tables, breaking every query in `@catamorphic/core`.

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

3. The `DB` type in `packages/db/src/generated/db.ts` is auto-updated (a `.ts` source file, gitignored — regenerate after pulling migration changes)
4. Use it in Kysely queries with full type safety

## Current tables

`tenants`, `projects`, `workflow_runs`, `workflow_run_steps`, `project_plugins`, `project_secrets` (+ `_migrations`). There is **no** `workflows` table — workflows are discovered by parsing project source (`(projectId, workflowName)` identifies one).

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
