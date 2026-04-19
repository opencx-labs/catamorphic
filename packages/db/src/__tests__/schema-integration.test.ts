import fs from "node:fs";
import path from "node:path";
import { vi } from "vitest";

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

import { sql } from "kysely";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDatabase } from "../database.js";
import { runMigrate } from "../migrate.js";
import { runReset } from "../reset.js";

const TEST_DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://catamorphic:catamorphic@localhost:5432/catamorphic";

function uniqueSchema(prefix: string) {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
}

async function schemaExists(connectionString: string, schema: string) {
  const db = createDatabase({ connectionString });
  try {
    const result = await sql<{ exists: boolean }>`
      SELECT EXISTS(
        SELECT 1 FROM information_schema.schemata WHERE schema_name = ${schema}
      ) AS exists
    `.execute(db);
    return Boolean(result.rows[0]?.exists);
  } finally {
    await db.destroy();
  }
}

async function dropSchema(connectionString: string, schema: string) {
  const db = createDatabase({ connectionString });
  try {
    await sql.raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).execute(db);
  } finally {
    await db.destroy();
  }
}

let dbAvailable = true;
const createdSchemas: string[] = [];
const originalDatabaseUrl = process.env.DATABASE_URL;
const originalSchema = process.env.CATAMORPHIC_DB_SCHEMA;

describe("@catamorphic/db schema integration", () => {
  beforeAll(async () => {
    dbAvailable = await schemaExists(TEST_DATABASE_URL, "public").catch(
      () => false,
    );
  });

  afterEach(async () => {
    process.env.DATABASE_URL = originalDatabaseUrl;
    process.env.CATAMORPHIC_DB_SCHEMA = originalSchema;
    for (const schema of createdSchemas.splice(0, createdSchemas.length)) {
      await dropSchema(TEST_DATABASE_URL, schema);
    }
  });

  it("runMigrate stores migration tracking in target schema", async () => {
    if (!dbAvailable) return;

    const schema = uniqueSchema("catamorphic_migrate_test");
    createdSchemas.push(schema);
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.CATAMORPHIC_DB_SCHEMA = schema;

    await runMigrate();

    const db = createDatabase({ connectionString: TEST_DATABASE_URL });
    try {
      const filesCount = fs
        .readdirSync(path.resolve(import.meta.dirname, "../../migrations"))
        .filter((file) => file.endsWith(".sql")).length;

      const migrationRows = await sql<{ count: string }>`
        SELECT COUNT(*)::text AS count FROM ${sql.raw(`"${schema}"._migrations`)}
      `.execute(db);

      const publicMigrationTable = await sql<{ exists: boolean }>`
        SELECT EXISTS(
          SELECT 1
          FROM pg_tables
          WHERE schemaname = 'public' AND tablename = '_migrations'
        ) AS exists
      `.execute(db);

      expect(Number(migrationRows.rows[0]?.count ?? "0")).toBe(filesCount);
      expect(publicMigrationTable.rows[0]?.exists).toBe(false);
    } finally {
      await db.destroy();
    }
  });

  it("runReset drops only target schema tables", async () => {
    if (!dbAvailable) return;

    const schema = uniqueSchema("catamorphic_reset_test");
    createdSchemas.push(schema);
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.CATAMORPHIC_DB_SCHEMA = schema;

    const db = createDatabase({ connectionString: TEST_DATABASE_URL });
    try {
      await sql.raw(`CREATE SCHEMA IF NOT EXISTS "${schema}"`).execute(db);
      await sql
        .raw(`CREATE TABLE IF NOT EXISTS public.test_public_guard (id int)`)
        .execute(db);
      await sql
        .raw(
          `CREATE TABLE IF NOT EXISTS "${schema}".test_schema_guard (id int)`,
        )
        .execute(db);
    } finally {
      await db.destroy();
    }

    await runReset();

    const verifyDb = createDatabase({ connectionString: TEST_DATABASE_URL });
    try {
      const publicTable = await sql<{ exists: boolean }>`
        SELECT EXISTS(
          SELECT 1
          FROM pg_tables
          WHERE schemaname = 'public' AND tablename = 'test_public_guard'
        ) AS exists
      `.execute(verifyDb);

      const schemaTable = await sql<{ exists: boolean }>`
        SELECT EXISTS(
          SELECT 1
          FROM pg_tables
          WHERE schemaname = ${schema} AND tablename = 'test_schema_guard'
        ) AS exists
      `.execute(verifyDb);

      expect(publicTable.rows[0]?.exists).toBe(true);
      expect(schemaTable.rows[0]?.exists).toBe(false);
    } finally {
      await sql
        .raw("DROP TABLE IF EXISTS public.test_public_guard")
        .execute(verifyDb);
      await verifyDb.destroy();
    }
  });

  it("runtime queries resolve to target schema before public", async () => {
    if (!dbAvailable) return;

    const schema = uniqueSchema("catamorphic_runtime_scope_test");
    const tableName = "runtime_scope_guard";
    createdSchemas.push(schema);

    const adminDb = createDatabase({ connectionString: TEST_DATABASE_URL });
    try {
      await sql.raw(`CREATE SCHEMA IF NOT EXISTS "${schema}"`).execute(adminDb);
      await sql
        .raw(
          `CREATE TABLE IF NOT EXISTS public.${tableName} (origin text NOT NULL)`,
        )
        .execute(adminDb);
      await sql
        .raw(
          `CREATE TABLE IF NOT EXISTS "${schema}".${tableName} (origin text NOT NULL)`,
        )
        .execute(adminDb);
      await sql.raw(`TRUNCATE TABLE public.${tableName}`).execute(adminDb);
      await sql.raw(`TRUNCATE TABLE "${schema}".${tableName}`).execute(adminDb);
      await sql
        .raw(`INSERT INTO public.${tableName} (origin) VALUES ('public')`)
        .execute(adminDb);
      await sql
        .raw(
          `INSERT INTO "${schema}".${tableName} (origin) VALUES ('catamorphic')`,
        )
        .execute(adminDb);
    } finally {
      await adminDb.destroy();
    }

    const schemaDb = createDatabase({
      connectionString: TEST_DATABASE_URL,
      schema,
    });
    try {
      const rows = await sql<{ origin: string }>`
        SELECT origin FROM ${sql.raw(tableName)} LIMIT 1
      `.execute(schemaDb);
      expect(rows.rows[0]?.origin).toBe("catamorphic");
    } finally {
      await schemaDb.destroy();
      const cleanupDb = createDatabase({ connectionString: TEST_DATABASE_URL });
      await sql
        .raw(`DROP TABLE IF EXISTS public.${tableName}`)
        .execute(cleanupDb);
      await cleanupDb.destroy();
    }
  });

  it("runtime queries do not fall through to public schema", async () => {
    if (!dbAvailable) return;

    const schema = uniqueSchema("catamorphic_no_fallback_test");
    const tableName = "runtime_public_only_guard";
    createdSchemas.push(schema);

    const adminDb = createDatabase({ connectionString: TEST_DATABASE_URL });
    try {
      await sql.raw(`CREATE SCHEMA IF NOT EXISTS "${schema}"`).execute(adminDb);
      await sql
        .raw(
          `CREATE TABLE IF NOT EXISTS public.${tableName} (origin text NOT NULL)`,
        )
        .execute(adminDb);
      await sql.raw(`TRUNCATE TABLE public.${tableName}`).execute(adminDb);
      await sql
        .raw(`INSERT INTO public.${tableName} (origin) VALUES ('public')`)
        .execute(adminDb);
    } finally {
      await adminDb.destroy();
    }

    const schemaDb = createDatabase({
      connectionString: TEST_DATABASE_URL,
      schema,
    });
    try {
      await expect(
        sql<{ origin: string }>`
          SELECT origin FROM ${sql.raw(tableName)} LIMIT 1
        `.execute(schemaDb),
      ).rejects.toThrow(/relation .* does not exist|does not exist/i);
    } finally {
      await schemaDb.destroy();
      const cleanupDb = createDatabase({ connectionString: TEST_DATABASE_URL });
      await sql
        .raw(`DROP TABLE IF EXISTS public.${tableName}`)
        .execute(cleanupDb);
      await cleanupDb.destroy();
    }
  });
});
