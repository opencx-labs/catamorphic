import fs from "node:fs";
import path from "node:path";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import {
  DEFAULT_SCHEMA,
  quoteIdentifier,
  resolveDatabaseUrl,
  resolveSchema,
} from "./config.js";
import { createDatabase } from "./database.js";
import { isExecutedDirectly } from "./is-main.js";
import { getMigrationsDir } from "./migrations-dir.js";
import { splitSqlStatements } from "./split-sql.js";

const MIGRATION_LOCK_KEY = "catamorphic:migrate";

export interface MigrateToLatestOptions<T> {
  /**
   * Any Kysely instance connected to the target database. Migrations run raw
   * SQL and schema-qualify everything explicitly, so the instance's own
   * search_path / schema plugin configuration does not matter.
   */
  db: Kysely<T>;
  /** Target schema. Created if missing. Defaults to `catamorphic`. */
  schema?: string;
  /** Called once per applied migration. Defaults to silent. */
  onApplied?: (name: string) => void;
}

export interface MigrateToLatestResult {
  schema: string;
  applied: string[];
}

/**
 * Apply all pending SQL migrations inside the target schema. Safe to call on
 * every boot: already-applied migrations are tracked in `<schema>._migrations`
 * and skipped. All catamorphic tables live in this schema so the host's own
 * tables are never touched.
 */
export async function migrateToLatest<T>({
  db,
  schema = DEFAULT_SCHEMA,
  onApplied,
}: MigrateToLatestOptions<T>): Promise<MigrateToLatestResult> {
  const quotedSchema = quoteIdentifier(schema);
  const migrationsTable = `${quotedSchema}._migrations`;
  const migrationsDir = getMigrationsDir();

  return db.transaction().execute(async (trx) => {
    // Some migration statements are database-global (notably CREATE
    // EXTENSION). Postgres' IF NOT EXISTS does not make concurrent extension
    // installation race-free, so migrations for different host schemas must
    // share one database-wide lock. Taking it before bootstrap also protects
    // two callers creating the same schema's tracking table together.
    await sql`SELECT pg_advisory_xact_lock(hashtext(${MIGRATION_LOCK_KEY}))`.execute(
      trx,
    );
    await sql.raw(`CREATE SCHEMA IF NOT EXISTS ${quotedSchema}`).execute(trx);
    await sql
      .raw(`
      CREATE TABLE IF NOT EXISTS ${migrationsTable} (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL UNIQUE,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `)
      .execute(trx);
    const applied = await sql<{ name: string }>`
      SELECT name FROM ${sql.raw(migrationsTable)} ORDER BY name
    `.execute(trx);
    const appliedSet = new Set(applied.rows.map((row) => row.name));
    const files = fs
      .readdirSync(migrationsDir)
      .filter((file) => file.endsWith(".sql"))
      .sort();
    const newlyApplied: string[] = [];
    for (const file of files) {
      if (appliedSet.has(file)) continue;
      const content = fs.readFileSync(path.join(migrationsDir, file), "utf-8");
      await sql.raw(`SET LOCAL search_path TO ${quotedSchema}`).execute(trx);
      // Statement-by-statement so single-connection dialects (PGlite) that
      // reject multi-command strings can run migrations too.
      for (const statement of splitSqlStatements(content)) {
        await sql.raw(statement).execute(trx);
      }
      await sql`
        INSERT INTO ${sql.raw(migrationsTable)} (name)
        VALUES (${file})
      `.execute(trx);
      newlyApplied.push(file);
      onApplied?.(file);
    }
    return { schema, applied: newlyApplied };
  });
}

export async function runMigrate() {
  const connectionString = resolveDatabaseUrl();
  const schema = resolveSchema();
  const db = createDatabase({ connectionString });

  await migrateToLatest({
    db,
    schema,
    onApplied: (name) => console.log(`  ✓ ${name}`),
  });

  console.log(`All migrations applied in schema "${schema}".`);
  await db.destroy();
}

if (isExecutedDirectly(import.meta.url)) {
  await runMigrate();
}
