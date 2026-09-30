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
} from "kysely";
import { Pool, types } from "pg";
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
  const database: NonNullable<BetterAuthOptions["database"]> = {
    dialect: new BetterAuthTypeNames(
      new SchemaScopedPostgresDialect({ pool, schema: authSchema }),
    ),
    type: "postgres",
  };

  return {
    database,
    migrate: async (args) => {
      // Replicas migrate one at a time. The lock lives in a transaction
      // held open for the migration, never in the session, so it ends with
      // the transaction even behind a transaction-mode pooler.
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          `catamorphic-auth:${authSchema}`,
        ]);
        await migrateBetterAuth(args);
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
