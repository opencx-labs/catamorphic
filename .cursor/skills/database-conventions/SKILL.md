# Database Conventions

## Stack

- **PostgreSQL 17** via Docker Compose
- **Kysely** for type-safe SQL queries
- **kysely-codegen** generates TypeScript types from the live database schema

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
