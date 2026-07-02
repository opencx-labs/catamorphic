import { Kysely, PostgresDialect, WithSchemaPlugin } from "kysely";
import pg from "pg";
import { DEFAULT_SCHEMA } from "./config.js";

export type CreateDatabaseOptions =
  | {
      /**
       * Connection string for a pool that catamorphic creates and owns. When
       * `schema` is set, `search_path` is configured on every connection.
       */
      connectionString: string;
      schema?: string;
    }
  | {
      /**
       * Host-owned `pg.Pool`. Catamorphic never ends the pool; the host owns
       * its lifetime. Because the pool's `search_path` belongs to the host,
       * all catamorphic queries are schema-qualified via `WithSchemaPlugin`
       * (default schema `catamorphic`).
       */
      pool: pg.Pool;
      schema?: string;
    };

export function createDatabase(options: CreateDatabaseOptions) {
  if ("pool" in options) {
    return new Kysely<import("./generated/db.js").DB>({
      dialect: new PostgresDialect({ pool: options.pool }),
      plugins: [new WithSchemaPlugin(options.schema ?? DEFAULT_SCHEMA)],
    });
  }

  const escapedSchema = options.schema?.replaceAll('"', '""');
  const poolOptions = escapedSchema
    ? `-c search_path="${escapedSchema}"`
    : undefined;
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    options: poolOptions,
  });

  return new Kysely<import("./generated/db.js").DB>({
    dialect: new PostgresDialect({ pool }),
  });
}
