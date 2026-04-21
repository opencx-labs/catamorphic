# Database Conventions

## Stack

- **PostgreSQL 17** via Docker Compose
- **Kysely** for type-safe SQL queries
- **kysely-codegen** generates TypeScript types from the live database schema

Catamorphic always lives in its own `catamorphic` schema (standalone dev creates it; hosts mount it inside their own database). The `db:codegen` script in [packages/db/package.json](../../packages/db/package.json) passes `--include-pattern 'catamorphic.*' --default-schema=catamorphic` so the generated `DB` type is scoped to Catamorphic tables only and uses bare names (`projects`, `tenants`, …), independent of whatever else lives in the target database. Do not remove those flags — running codegen against a host DB (e.g. OpenCX) without them will generate unqualified names for host tables and schema-qualified names for Catamorphic tables, breaking every query in `@catamorphic/core`.

## Connection

```
DATABASE_URL=postgresql://catamorphic:catamorphic@localhost:5432/catamorphic
```

## Migrations

Forward-only raw SQL in `packages/db/migrations/`. Numbered sequentially:

```
001_initial.sql
002_add_workflow_tags.sql
```

To undo something, write a new forward migration. Never write down migrations.

## Adding a New Table

1. Create a new `.sql` file in `packages/db/migrations/`
2. Run migrations and regenerate types:

```bash
bun run db:migrate
bun run db:codegen
```

3. The `DB` type in `packages/db/src/generated/db.d.ts` is auto-updated
4. Use it in Kysely queries with full type safety

## Querying

```typescript
import { createDatabase } from "@catamorphic/db";

const db = createDatabase({ connectionString: process.env.DATABASE_URL });
const workflows = await db.selectFrom("workflows").selectAll().execute();
```
