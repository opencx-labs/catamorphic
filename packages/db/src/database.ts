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

/**
 * Pool ceilings by Kysely instance, recorded at construction.
 *
 * Kysely keeps its dialect (and therefore the pg pool) behind private fields,
 * so a consumer that wants to sanity-check its own concurrency against the
 * pool — the worker does — cannot reach the number after the fact. Recording
 * it here at the only points where the pool passes through our hands makes
 * the check possible without holding the pool itself alive.
 */
const poolSizes = new WeakMap<object, number>();

/**
 * The connection ceiling of the pool behind a {@link createDatabase} instance,
 * or undefined for databases that did not pass through it.
 */
export function knownPoolSize(db: object): number | undefined {
  return poolSizes.get(db);
}

export function createDatabase(options: CreateDatabaseOptions) {
  if ("pool" in options) {
    const db = new Kysely<import("./generated/db.js").DB>({
      dialect: new PostgresDialect({ pool: options.pool }),
      plugins: [new WithSchemaPlugin(options.schema ?? DEFAULT_SCHEMA)],
    });
    const max = options.pool.options?.max;
    if (typeof max === "number") poolSizes.set(db, max);
    return db;
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

  const db = new Kysely<import("./generated/db.js").DB>({
    dialect: new PostgresDialect({ pool }),
  });
  poolSizes.set(db, options.poolSize ?? DEFAULT_POOL_SIZE);
  return db;
}
