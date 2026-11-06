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
import { createDatabase, withStorableParameters } from "../database.js";
import { jsonbText, storableText, storedJson } from "../storable-parameters.js";

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
  return withStorableParameters(
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

describe("parameters reach Postgres as values it stores", () => {
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

  it("reaches every shape a query builder or template gives a value", () => {
    const db = compiler();
    // A row with an expression becomes a list of value nodes.
    expect(
      db
        .insertInto("json_rows")
        .values({ id: "a", items: [], label: sql`default` })
        .compile().parameters,
    ).toEqual(["a", "[]"]);
    expect(
      db
        .insertInto("json_rows")
        .values({ id: "a", items: [], label: "x" })
        .onConflict((oc) => oc.column("id").doUpdateSet({ items: ["b"] }))
        .compile().parameters,
    ).toEqual(["a", "[]", "x", '["b"]']);
    expect(
      db
        .selectFrom("json_rows")
        .select((eb) => eb.val(["a"]).as("items"))
        .compile().parameters,
    ).toEqual(['["a"]']);
    expect(
      sql`select ${sql.val(["a"])}, ${sql.join([["b"], "c"])}`.compile(db)
        .parameters,
    ).toEqual(['["a"]', '["b"]', "c"]);
    // A jsonb `in` list: its elements are the arrays.
    expect(
      db
        .selectFrom("json_rows")
        .select("id")
        .where("items", "in", [["a"], []])
        .compile().parameters,
    ).toEqual(['["a"]', "[]"]);
  });

  it("sends plain objects as JSON text and leaves other values alone", () => {
    const db = compiler();
    expect(
      db
        .updateTable("json_rows")
        .set({ items: { kind: "execute" } })
        .compile().parameters,
    ).toEqual(['{"kind":"execute"}']);
    expect(
      db
        .selectFrom("json_rows")
        .select("id")
        .where("id", "in", ["a", "b"])
        .compile().parameters,
    ).toEqual(["a", "b"]);
    const at = new Date(0);
    const bytes = Buffer.from("x");
    expect(sql`select ${at}, ${bytes}, ${1}`.compile(db).parameters).toEqual([
      at,
      bytes,
      1,
    ]);
  });

  it("writes half of a surrogate pair and U+0000 as U+FFFD", () => {
    // A cut at a length through an emoji leaves its first or second half.
    const cut = "🚀".slice(0, 1);
    const tail = "🚀".slice(1);
    expect(jsonbText({ text: `a${cut}`, [`k${tail}`]: "b\u0000" })).toBe(
      '{"text":"a\\ufffd","k\\ufffd":"b\\ufffd"}',
    );
    expect(jsonbText(["\u0000", "\ud83d"])).toBe('["\\ufffd","\\ufffd"]');
    // Whole pairs and text that only reads like an escape are kept.
    expect(jsonbText(["🚀", "\\ud83d"])).toBe('["🚀","\\\\ud83d"]');
    expect(jsonbText("plain")).toBe('"plain"');
    const db = compiler();
    expect(
      db
        .insertInto("json_rows")
        .values({ id: "a\u0000", items: [`x${cut}`], label: `y${tail}🚀` })
        .compile().parameters,
    ).toEqual(["a\ufffd", '["x\\ufffd"]', "y\ufffd🚀"]);
    expect(
      db
        .updateTable("json_rows")
        .set({ items: { output: "\u0000" } })
        .where("label", "in", ["\u0000"])
        .compile().parameters,
    ).toEqual(['{"output":"\\ufffd"}', "\ufffd"]);
  });

  it("gives text and JSON back as Postgres stores them", () => {
    const cut = "🚀".slice(0, 1);
    expect(storableText(`a${cut}b\u0000🚀 \\ud83d`)).toBe(
      "a\ufffdb\ufffd🚀 \\ud83d",
    );
    expect(
      storedJson({
        title: `x${cut}`,
        items: ["\u0000", "🚀"],
        gone: undefined,
      }),
    ).toStrictEqual({ title: "x\ufffd", items: ["\ufffd", "🚀"] });
  });

  it("is applied once however often it is asked for", () => {
    const db = compiler();
    expect(withStorableParameters(db)).toBe(db);
  });

  it("is applied to every database createDatabase opens", async () => {
    const db = createDatabase({ connectionString: "postgres://127.0.0.1:1/x" });
    try {
      expect(withStorableParameters(db)).toBe(db);
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
    // Text a tool printed: an emoji cut in half, a NUL byte, and the second
    // half of an emoji after a two-byte character, which PGlite miscounts.
    const cut = `out ${"🚀".slice(0, 1)}`;
    await db
      .insertInto("json_rows")
      .values({
        id: "unstorable",
        items: { output: cut, [cut]: ["\u0000"] },
        label: `${cut}\u0000é${"🚀".slice(1)}!`,
      })
      .execute();
    await sql`update json_rows set items = items || ${jsonbText({ tail: cut })}::jsonb where id = 'unstorable'`.execute(
      db,
    );
    const read = await sql<{
      id: string;
      items: unknown;
      label: string;
      type: string;
    }>`select id, items, label, jsonb_typeof(items) as type from json_rows order by id`.execute(
      db,
    );
    expect(read.rows).toEqual([
      { id: "empty", items: [{ kind: "execute" }], label: "x", type: "array" },
      { id: "strings", items: ["read", "write"], label: "x", type: "array" },
      {
        id: "unstorable",
        items: {
          output: "out \uFFFD",
          "out \uFFFD": ["\uFFFD"],
          tail: "out \uFFFD",
        },
        label: "out \uFFFD\uFFFDé\uFFFD!",
        type: "object",
      },
    ]);
  }

  it("round-trips JSON values through PGlite", async () => {
    const db = withStorableParameters(
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
    "round-trips JSON values through node-postgres",
    async () => {
      const schema = `storable_parameters_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
      const admin = new pg.Client({
        connectionString: process.env.DATABASE_URL,
      });
      await admin.connect();
      await admin.query(`create schema ${schema}`);
      const db = withStorableParameters(
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
