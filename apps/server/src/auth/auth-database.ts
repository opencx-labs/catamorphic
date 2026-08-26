import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type { BetterAuthOptions } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { PGliteDialect } from "kysely";
import { Pool } from "pg";

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
    await bootstrap.query(`CREATE SCHEMA IF NOT EXISTS "${authSchema}"`);
  } finally {
    await bootstrap.end();
  }

  const pool = new Pool({
    connectionString,
    options: `-c search_path=${authSchema},public`,
  });

  return {
    database: pool,
    migrate: migrateBetterAuth,
    close: () => pool.end(),
  };
}

async function migrateBetterAuth(args: {
  options: BetterAuthOptions;
}): Promise<void> {
  const migrations = await getMigrations(args.options);
  await migrations.runMigrations();
}
