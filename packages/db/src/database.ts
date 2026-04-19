import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";

export function createDatabase({
  connectionString,
  schema,
}: {
  connectionString: string;
  schema?: string;
}) {
  const escapedSchema = schema?.replaceAll('"', '""');
  const options = escapedSchema
    ? `-c search_path="${escapedSchema}"`
    : undefined;
  const pool = new pg.Pool({ connectionString, options });

  return new Kysely<import("./generated/db.js").DB>({
    dialect: new PostgresDialect({
      pool,
    }),
  });
}
