import { execSync } from "node:child_process";
import { sql } from "kysely";
import { createDatabase } from "./database.js";

const connectionString =
  process.env.DATABASE_URL ??
  "postgresql://catamorphic:catamorphic@localhost:5432/catamorphic";

const db = createDatabase({ connectionString });

const tables = await sql<{ tablename: string }>`
  SELECT tablename FROM pg_tables WHERE schemaname = 'public'
`.execute(db);

for (const { tablename } of tables.rows) {
  await sql`DROP TABLE IF EXISTS ${sql.ref(tablename)} CASCADE`.execute(db);
}
console.log("All tables dropped.");

await db.destroy();

execSync("bun run db:migrate", { stdio: "inherit" });
execSync("bun run db:codegen", { stdio: "inherit" });
