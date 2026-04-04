import fs from "node:fs";
import path from "node:path";
import { sql } from "kysely";
import { createDatabase } from "./database.js";

const connectionString =
  process.env.DATABASE_URL ??
  "postgresql://catamorphic:catamorphic@localhost:5432/catamorphic";

const db = createDatabase({ connectionString });

const migrationsDir = path.resolve(import.meta.dirname, "../migrations");

await sql`
  CREATE TABLE IF NOT EXISTS _migrations (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL UNIQUE,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )
`.execute(db);

const applied = await sql<{ name: string }>`
  SELECT name FROM _migrations ORDER BY name
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
    await sql.raw(content).execute(trx);
    await sql`INSERT INTO _migrations (name) VALUES (${file})`.execute(trx);
  });

  console.log(`  ✓ ${file}`);
}

console.log("All migrations applied.");
await db.destroy();
