import fs from "node:fs";
import path from "node:path";
import { sql } from "kysely";
import {
  quoteIdentifier,
  resolveDatabaseUrl,
  resolveSchema,
} from "./config.js";
import { createDatabase } from "./database.js";
import { isExecutedDirectly } from "./is-main.js";
import { getMigrationsDir } from "./migrations-dir.js";

export async function runMigrate() {
  const connectionString = resolveDatabaseUrl();
  const schema = resolveSchema();
  const quotedSchema = quoteIdentifier(schema);
  const migrationsTable = `${quotedSchema}._migrations`;

  const db = createDatabase({ connectionString });

  const migrationsDir = getMigrationsDir();

  await sql.raw(`CREATE SCHEMA IF NOT EXISTS ${quotedSchema}`).execute(db);
  await sql
    .raw(`
    CREATE TABLE IF NOT EXISTS ${migrationsTable} (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)
    .execute(db);

  const applied = await sql<{ name: string }>`
    SELECT name FROM ${sql.raw(migrationsTable)} ORDER BY name
  `.execute(db);

  const appliedSet = new Set(applied.rows.map((r) => r.name));

  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    if (appliedSet.has(file)) continue;

    const content = fs.readFileSync(path.join(migrationsDir, file), "utf-8");
    console.log(`Applying migration: ${file}`);

    await db.transaction().execute(async (trx) => {
      await sql.raw(`SET LOCAL search_path TO ${quotedSchema}`).execute(trx);
      await sql.raw(content).execute(trx);
      await sql`
        INSERT INTO ${sql.raw(migrationsTable)} (name)
        VALUES (${file})
      `.execute(trx);
    });

    console.log(`  ✓ ${file}`);
  }

  console.log(`All migrations applied in schema "${schema}".`);
  await db.destroy();
}

if (isExecutedDirectly(import.meta.url)) {
  await runMigrate();
}
