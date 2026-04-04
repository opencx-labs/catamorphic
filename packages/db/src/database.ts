import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";

export function createDatabase({
  connectionString,
}: {
  connectionString: string;
}) {
  return new Kysely<import("./generated/db.js").DB>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString }),
    }),
  });
}
