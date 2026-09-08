import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type { BetterAuthOptions } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { PGliteDialect } from "kysely";
import { Pool } from "pg";
import { SchemaScopedPostgresDialect } from "./schema-scoped-postgres-dialect.js";

const AUTH_SCHEMA = "catamorphic_auth";

export interface OpenStockAuthDatabaseOptions {
  dataDir: string;
  databaseUrl?: string;
  /** Test/host override. Stock deployments use `catamorphic_auth`. */
  authSchema?: string;
}

export interface StockAuthDatabase {
  database: NonNullable<BetterAuthOptions["database"]>;
  migrate(args: { options: BetterAuthOptions }): Promise<void>;
  close(): Promise<void>;
}

/**
 * Opens the stock host's Better Auth database without sharing Catamorphic's
 * schema or mutating its long-lived PGlite session.
 */
export async function openStockAuthDatabase(
  options: OpenStockAuthDatabaseOptions,
): Promise<StockAuthDatabase> {
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
    dialect: new PGliteDialect({ pglite }),
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
): Promise<StockAuthDatabase> {
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
  });
  const database: NonNullable<BetterAuthOptions["database"]> = {
    dialect: new SchemaScopedPostgresDialect({ pool, schema: authSchema }),
    type: "postgres",
  };

  return {
    database,
    migrate: async (args) => {
      const client = await pool.connect();
      try {
        await client.query("SELECT pg_advisory_lock(hashtext($1))", [
          `catamorphic-auth:${authSchema}`,
        ]);
        await migrateBetterAuth(args);
      } finally {
        await client.query("SELECT pg_advisory_unlock(hashtext($1))", [
          `catamorphic-auth:${authSchema}`,
        ]);
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
