import fs from "node:fs";
import { sql } from "kysely";
import {
  quoteIdentifier,
  resolveDatabaseUrl,
  resolveSchema,
} from "./config.js";
import { createDatabase } from "./database.js";
import { getMigrationsDir } from "./migrations-dir.js";

export async function runStatus() {
  const connectionString = resolveDatabaseUrl();
  const schema = resolveSchema();
  const quotedSchema = quoteIdentifier(schema);
  const migrationsTable = `${quotedSchema}._migrations`;
  const db = createDatabase({ connectionString });

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

  const migrationsDir = getMigrationsDir();
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const applied = await sql<{ name: string }>`
    SELECT name FROM ${sql.raw(migrationsTable)} ORDER BY name
  `.execute(db);
  const appliedSet = new Set(applied.rows.map((row) => row.name));

  const pending = files.filter((file) => !appliedSet.has(file));
  console.log(`Schema: ${schema}`);
  console.log(`Applied: ${applied.rows.length}`);
  console.log(`Pending: ${pending.length}`);
  for (const file of pending) {
    console.log(`- ${file}`);
  }

  await db.destroy();
}
