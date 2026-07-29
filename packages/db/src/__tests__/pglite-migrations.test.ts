import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { Kysely, PGliteDialect, sql, WithSchemaPlugin } from "kysely";
import { afterAll, describe, expect, it } from "vitest";
import { DEFAULT_SCHEMA } from "../config.js";
import type { DB } from "../generated/db.js";
import { migrateToLatest } from "../migrate.js";
import { splitSqlStatements } from "../split-sql.js";

/**
 * Guards PGlite compatibility for embedded hosts (the desktop app): every
 * migration must apply on PGlite, not just full Postgres. PGlite is
 * single-connection and speaks the extended protocol, so multi-command
 * strings and unavailable extensions surface here first.
 */

// One shared wasm instance for the whole file: booting PGlite is expensive
// and doing it per-test starves sibling packages' timing-sensitive tests
// when the monorepo suite runs in parallel.
const pglite = new PGlite({ extensions: { pgcrypto } });
const db = new Kysely<DB>({
  dialect: new PGliteDialect({ pglite }),
  plugins: [new WithSchemaPlugin(DEFAULT_SCHEMA)],
});

afterAll(async () => {
  await db.destroy();
});

// PGlite is wasm: instance boot plus 35 migrations can exceed the default 5s
// timeout when the whole monorepo test suite runs in parallel.
const PGLITE_TIMEOUT = 60_000;

describe("PGlite migrations", () => {
  it("applies every migration on an in-memory PGlite", {
    timeout: PGLITE_TIMEOUT,
  }, async () => {
    const result = await migrateToLatest({ db });
    expect(result.schema).toBe(DEFAULT_SCHEMA);
    expect(result.applied.length).toBeGreaterThan(30);

    const rerun = await migrateToLatest({ db });
    expect(rerun.applied).toEqual([]);
  });

  it("supports the runtime primitives core relies on", {
    timeout: PGLITE_TIMEOUT,
  }, async () => {
    await migrateToLatest({ db });

    const uuid = await sql<{ id: string }>`
      SELECT gen_random_uuid()::text AS id
    `.execute(db);
    expect(uuid.rows[0]?.id).toHaveLength(36);

    await db.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtext('pglite-test'))`.execute(
        trx,
      );
      const locked = await sql<{ id: string }>`
        SELECT id FROM catamorphic.tenants FOR UPDATE SKIP LOCKED
      `.execute(trx);
      expect(locked.rows).toEqual([]);
    });

    const hash = await sql<{ h: string }>`
      SELECT hashtextextended('pglite-test', 0)::text AS h
    `.execute(db);
    expect(hash.rows[0]?.h).toBeDefined();
  });

  it("round-trips writes through the schema-scoped Kysely instance", {
    timeout: PGLITE_TIMEOUT,
  }, async () => {
    await migrateToLatest({ db });

    const tenant = await db
      .insertInto("tenants")
      .values({ name: "pglite-smoke" })
      .returning(["id", "name"])
      .executeTakeFirstOrThrow();
    expect(tenant.name).toBe("pglite-smoke");

    const read = await db
      .selectFrom("tenants")
      .select(["id", "name"])
      .where("id", "=", tenant.id)
      .executeTakeFirstOrThrow();
    expect(read.id).toBe(tenant.id);
  });
});

describe("splitSqlStatements", () => {
  it("splits on semicolons outside strings and comments", () => {
    const statements = splitSqlStatements(`
      -- leading comment; not a split
      CREATE TABLE a (x text DEFAULT 'semi;colon');
      /* block; comment */
      UPDATE a SET x = 'done';
    `);
    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain("'semi;colon'");
    expect(statements[1]).toContain("block; comment");
  });

  it("keeps dollar-quoted bodies intact", () => {
    const statements = splitSqlStatements(
      `CREATE FUNCTION f() RETURNS void AS $$ BEGIN PERFORM 1; END $$ LANGUAGE plpgsql; SELECT 1;`,
    );
    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain("PERFORM 1; END");
  });

  it("handles escaped quotes", () => {
    const statements = splitSqlStatements(
      `INSERT INTO t VALUES ('it''s; fine'); SELECT 1;`,
    );
    expect(statements).toHaveLength(2);
  });
});
