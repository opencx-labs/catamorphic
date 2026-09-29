import { PGlite } from "@electric-sql/pglite";
import {
  DummyDriver,
  Kysely,
  PGliteDialect,
  PostgresAdapter,
  PostgresDialect,
  PostgresIntrospector,
  PostgresQueryCompiler,
  sql,
} from "kysely";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { createDatabase, withJsonArrayParameters } from "../database.js";

interface Row {
  id: string;
  items: unknown;
  label: string;
}
interface TestDb {
  json_rows: Row;
}

/** A database that only compiles queries. */
function compiler() {
  return withJsonArrayParameters(
    new Kysely<TestDb>({
      dialect: {
        createAdapter: () => new PostgresAdapter(),
        createDriver: () => new DummyDriver(),
        createIntrospector: (db) => new PostgresIntrospector(db),
        createQueryCompiler: () => new PostgresQueryCompiler(),
      },
    }),
  );
}

describe("array parameters reach jsonb as JSON", () => {
  it("sends inserted, updated, and raw array values as JSON text", () => {
    const db = compiler();
    expect(
      db
        .insertInto("json_rows")
        .values({ id: "a", items: ["read", "write"], label: "x" })
        .compile().parameters,
    ).toEqual(["a", '["read","write"]', "x"]);
    expect(
      db
        .insertInto("json_rows")
        .values([
          { id: "a", items: [], label: "x" },
          { id: "b", items: [{ kind: "execute" }], label: "y" },
        ])
        .compile().parameters,
    ).toEqual(["a", "[]", "x", "b", '[{"kind":"execute"}]', "y"]);
    expect(
      db
        .updateTable("json_rows")
        .set({ items: [] })
        .where("id", "=", "a")
        .compile().parameters,
    ).toEqual(["[]", "a"]);
    expect(sql`select ${["a"]}::jsonb`.compile(db).parameters).toEqual([
      '["a"]',
    ]);
  });

  it("leaves `in` lists and objects alone", () => {
    const db = compiler();
    expect(
      db
        .selectFrom("json_rows")
        .select("id")
        .where("id", "in", ["a", "b"])
        .compile().parameters,
    ).toEqual(["a", "b"]);
    expect(
      db
        .updateTable("json_rows")
        .set({ items: { kind: "execute" } })
        .compile().parameters,
    ).toEqual([{ kind: "execute" }]);
  });

  it("is applied once however often it is asked for", () => {
    const db = compiler();
    expect(withJsonArrayParameters(db)).toBe(db);
  });

  it("is applied to every database createDatabase opens", async () => {
    const db = createDatabase({ connectionString: "postgres://127.0.0.1:1/x" });
    try {
      expect(withJsonArrayParameters(db)).toBe(db);
    } finally {
      await db.destroy();
    }
  });

  async function roundTrip(db: Kysely<TestDb>) {
    await sql`create table json_rows (id text primary key, items jsonb not null, label text not null)`.execute(
      db,
    );
    await db
      .insertInto("json_rows")
      .values([
        { id: "empty", items: [], label: "x" },
        { id: "strings", items: ["read", "write"], label: "x" },
      ])
      .execute();
    await db
      .updateTable("json_rows")
      .set({ items: [{ kind: "execute" }] })
      .where("id", "=", "empty")
      .execute();
    const read = await sql<{
      id: string;
      items: unknown;
      type: string;
    }>`select id, items, jsonb_typeof(items) as type from json_rows order by id`.execute(
      db,
    );
    expect(read.rows).toEqual([
      { id: "empty", items: [{ kind: "execute" }], type: "array" },
      { id: "strings", items: ["read", "write"], type: "array" },
    ]);
  }

  it("round-trips arrays through PGlite", async () => {
    const db = withJsonArrayParameters(
      new Kysely<TestDb>({
        dialect: new PGliteDialect({ pglite: new PGlite() }),
      }),
    );
    try {
      await roundTrip(db);
    } finally {
      await db.destroy();
    }
  });

  it.skipIf(!process.env.DATABASE_URL)(
    "round-trips arrays through node-postgres",
    async () => {
      const schema = `json_arrays_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
      const admin = new pg.Client({
        connectionString: process.env.DATABASE_URL,
      });
      await admin.connect();
      await admin.query(`create schema ${schema}`);
      const db = withJsonArrayParameters(
        new Kysely<TestDb>({
          dialect: new PostgresDialect({
            pool: new pg.Pool({
              connectionString: process.env.DATABASE_URL,
              options: `-c search_path=${schema}`,
            }),
          }),
        }),
      );
      try {
        await roundTrip(db);
      } finally {
        await db.destroy();
        await admin.query(`drop schema ${schema} cascade`);
        await admin.end();
      }
    },
  );
});
