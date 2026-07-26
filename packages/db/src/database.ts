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
      /**
       * Maximum pooled connections. Defaults to {@link DEFAULT_POOL_SIZE}.
       *
       * Size this above the total worker concurrency you start (see
       * `startWorker({ concurrency })`), with headroom for the host's own
       * queries: every loop holds a connection for the length of its
       * transaction.
       */
      poolSize?: number;
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

/**
 * Pooled connections for a catamorphic-owned pool.
 *
 * A worker loop holds a connection for the length of each transaction, and a
 * host serves requests from the same pool. node-postgres defaults to 10, which
 * a worker at moderate concurrency exhausts on its own — and pool-acquire
 * timeouts surface as generic query failures, so the misconfiguration reads as
 * database trouble rather than a too-small pool.
 */
export const DEFAULT_POOL_SIZE = 20;

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
    max: options.poolSize ?? DEFAULT_POOL_SIZE,
  });

  return new Kysely<import("./generated/db.js").DB>({
    dialect: new PostgresDialect({ pool }),
  });
}
