import { execSync } from "node:child_process";
import { sql } from "kysely";
import {
  quoteIdentifier,
  resolveDatabaseUrl,
  resolveSchema,
} from "./config.js";
import { createDatabase } from "./database.js";
import { isExecutedDirectly } from "./is-main.js";

export async function runReset() {
  const connectionString = resolveDatabaseUrl();
  const schema = resolveSchema();
  const quotedSchema = quoteIdentifier(schema);
  const db = createDatabase({ connectionString });

  await sql.raw(`CREATE SCHEMA IF NOT EXISTS ${quotedSchema}`).execute(db);

  const tables = await sql<{ tablename: string }>`
    SELECT tablename FROM pg_tables WHERE schemaname = ${schema}
  `.execute(db);

  for (const { tablename } of tables.rows) {
    const quotedTable = quoteIdentifier(tablename);
    await sql
      .raw(`DROP TABLE IF EXISTS ${quotedSchema}.${quotedTable} CASCADE`)
      .execute(db);
  }
  console.log(`All tables dropped in schema "${schema}".`);

  await db.destroy();

  execSync("bun run db:migrate", { stdio: "inherit" });
  execSync("bun run db:codegen", { stdio: "inherit" });
}

if (isExecutedDirectly(import.meta.url)) {
  await runReset();
}
