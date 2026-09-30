import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type { BetterAuthOptions } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import {
  type DatabaseIntrospector,
  type Dialect,
  type Kysely,
  PGliteDialect,
  type PostgresPool,
} from "kysely";
import { Pool, type PoolClient, types } from "pg";
import { SchemaScopedPostgresDialect } from "./schema-scoped-postgres-dialect.js";

const AUTH_SCHEMA = "catamorphic_auth";

export interface OpenWorkAuthDatabaseOptions {
  dataDir: string;
  databaseUrl?: string;
  /** Test/host override. Work server deployments use `catamorphic_auth`. */
  authSchema?: string;
}

export interface WorkAuthDatabase {
  database: NonNullable<BetterAuthOptions["database"]>;
  migrate(args: { options: BetterAuthOptions }): Promise<void>;
  close(): Promise<void>;
}

/**
 * Opens the Work server's Better Auth database without sharing Catamorphic's
 * schema or mutating its long-lived PGlite session.
 */
export async function openWorkAuthDatabase(
  options: OpenWorkAuthDatabaseOptions,
): Promise<WorkAuthDatabase> {
  if (options.databaseUrl) {
    return openPostgresAuthDatabase(
      options.databaseUrl,
      options.authSchema ?? AUTH_SCHEMA,
    );
  }

  const authDataPath = path.join(options.dataDir, "auth-db");
  fs.mkdirSync(authDataPath, { recursive: true });
  const pglite = new PGlite(authDataPath);
  const database: NonNullable<BetterAuthOptions["database"]> = {
    dialect: new BetterAuthTypeNames(new PGliteDialect({ pglite })),
    type: "postgres",
  };

  return {
    database,
    migrate: migrateBetterAuth,
    close: () => pglite.close(),
  };
}

async function openPostgresAuthDatabase(
  connectionString: string,
  authSchema: string,
): Promise<WorkAuthDatabase> {
  if (!/^[a-z_][a-z0-9_]*$/.test(authSchema)) {
    throw new Error(`Invalid Better Auth schema name: ${authSchema}`);
  }
  const bootstrap = new Pool({ connectionString });
  try {
    const client = await bootstrap.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `catamorphic-auth:${authSchema}`,
      ]);
      await client.query(`CREATE SCHEMA IF NOT EXISTS "${authSchema}"`);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await bootstrap.end();
  }

  const pool = new Pool({
    connectionString,
    options: `-c search_path=${authSchema},public`,
    // Better Auth's only bigint is the rate-limit row's millisecond clock,
    // which it does arithmetic on; node-postgres would hand it a string.
    types: {
      getTypeParser: (oid, format) =>
        oid === types.builtins.INT8 && format !== "binary"
          ? (value: string) => Number(value)
          : types.getTypeParser(oid, format),
    },
  });
  // The server can end an idle pooled connection (a restart, a dropped
  // database); node-postgres discards it and reports it here, and an
  // unheard report would crash the process.
  pool.on("error", (error) => {
    console.warn(
      `[catamorphic] An idle auth database connection closed; the pool replaces it: ${error.message}`,
    );
  });
  const database: NonNullable<BetterAuthOptions["database"]> = {
    dialect: new BetterAuthTypeNames(
      new SchemaScopedPostgresDialect({ pool, schema: authSchema }),
    ),
    type: "postgres",
  };

  return {
    database,
    migrate: async (args) => {
      // Replicas migrate one at a time. The lock lives in the transaction
      // the migration runs in, never in the session, so it ends with the
      // transaction even behind a transaction-mode pooler, and a failed
      // migration leaves no half-created tables.
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          `catamorphic-auth:${authSchema}`,
        ]);
        await migrateBetterAuth({
          options: {
            ...args.options,
            database: {
              dialect: new BetterAuthTypeNames(
                new SchemaScopedPostgresDialect({
                  pool: onConnection(client),
                  schema: authSchema,
                }),
              ),
              type: "postgres",
            },
          },
        });
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

async function migrateBetterAuth(args: {
  options: BetterAuthOptions;
}): Promise<void> {
  const migrations = await getMigrations(args.options);
  await migrations.runMigrations();
}

/**
 * A pool of the one connection holding the migration's transaction. Kysely
 * releases a connection after every query; this one stays checked out
 * until the transaction ends.
 */
function onConnection(client: PoolClient): PostgresPool {
  return {
    options: {},
    connect: async () => ({
      query: client.query.bind(client),
      release: () => undefined,
    }),
    end: async () => undefined,
  };
}

/**
 * Better Auth's migration check (1.6.26) knows a bigint column as `bigint`
 * but Postgres catalogs name it `int8`, so every boot would warn that the
 * rate-limit table's `lastRequest` has the wrong type. Report the name it
 * knows.
 */
class BetterAuthTypeNames implements Dialect {
  constructor(private readonly base: Dialect) {}

  createDriver() {
    return this.base.createDriver();
  }

  createQueryCompiler() {
    return this.base.createQueryCompiler();
  }

  createAdapter() {
    return this.base.createAdapter();
  }

  createIntrospector(db: Kysely<unknown>): DatabaseIntrospector {
    const introspector = this.base.createIntrospector(db);
    return {
      getSchemas: () => introspector.getSchemas(),
      getTables: async (options) =>
        (await introspector.getTables(options)).map((table) => ({
          ...table,
          columns: table.columns.map((column) =>
            column.dataType === "int8"
              ? { ...column, dataType: "bigint" }
              : column,
          ),
        })),
    };
  }
}
