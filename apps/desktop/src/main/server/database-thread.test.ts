import { MessageChannel } from "node:worker_threads";
import { PGlite } from "@electric-sql/pglite";
import { Kysely, PGliteDialect, sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  connectDatabaseThread,
  type DatabaseThread,
} from "./database-thread.js";
import { serveDatabase } from "./database-thread-server.js";

/**
 * The channel's two ends in one thread: the protocol, the transactions and
 * the errors are the same; only the thread is missing.
 */
function connect() {
  const { port1, port2 } = new MessageChannel();
  const pglite = new PGlite();
  serveDatabase({ pglite, port: port2 });
  let lose: (error: Error) => void = () => {};
  const database = connectDatabaseThread({
    port: port1,
    lost: (listener) => {
      lose = listener;
    },
    stop: async () => {
      port1.close();
      port2.close();
    },
  });
  return { database, pglite, lose: (error: Error) => lose(error) };
}

let database: DatabaseThread;
let lose: (error: Error) => void;
beforeEach(async () => {
  ({ database, lose } = connect());
  await database.waitReady;
  await database.exec(
    "CREATE TABLE notes (id integer PRIMARY KEY, body text NOT NULL, CONSTRAINT notes_body_key UNIQUE (body))",
  );
});
afterEach(async () => {
  await database.close().catch(() => {});
});

const bodies = async () =>
  (
    await database.query<{ body: string }>("SELECT body FROM notes ORDER BY id")
  ).rows.map((row) => row.body);

describe("the database on its own thread", () => {
  it("answers statements with what PGlite returns", async () => {
    expect(database.ready).toBe(true);
    const inserted = await database.query(
      "INSERT INTO notes (id, body) VALUES ($1, $2), ($3, $4)",
      [1, "first", 2, "second"],
    );
    expect(inserted.affectedRows).toBe(2);
    expect(await bodies()).toEqual(["first", "second"]);
    const arrays = await database.query(
      "SELECT id, body FROM notes ORDER BY id",
      [],
      { rowMode: "array" },
    );
    expect(arrays.rows).toEqual([
      [1, "first"],
      [2, "second"],
    ]);
    // Values keep their types across the channel.
    const typed = await database.query<{
      at: Date;
      doc: { nested: number[] };
      big: bigint;
    }>(
      `SELECT now() AS at, '{"nested":[1,2]}'::jsonb AS doc, 9007199254740993::bigint AS big`,
    );
    expect(typed.rows[0]?.at).toBeInstanceOf(Date);
    expect(typed.rows[0]?.doc).toEqual({ nested: [1, 2] });
    expect(typed.rows[0]?.big).toBe(9007199254740993n);
  });

  it("commits a transaction that returns and rolls back one that throws or asks to", async () => {
    await database.transaction(async (transaction) => {
      await transaction.query("INSERT INTO notes VALUES (1, 'kept')");
    });
    await expect(
      database.transaction(async (transaction) => {
        await transaction.query("INSERT INTO notes VALUES (2, 'thrown away')");
        throw new Error("changed my mind");
      }),
    ).rejects.toThrow("changed my mind");
    await database.transaction(async (transaction) => {
      await transaction.query("INSERT INTO notes VALUES (3, 'taken back')");
      await transaction.rollback();
    });
    expect(await bodies()).toEqual(["kept"]);
  });

  it("keeps a Postgres error's code and constraint, and the transaction it failed in usable by nobody", async () => {
    await database.query("INSERT INTO notes VALUES (1, 'once')");
    const failure = await database
      .query("INSERT INTO notes VALUES (2, 'once')")
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).toMatchObject({
      code: "23505",
      constraint: "notes_body_key",
    });
    await expect(
      database.transaction(async (transaction) => {
        await transaction.query("INSERT INTO notes VALUES (3, 'once')");
      }),
    ).rejects.toMatchObject({ code: "23505" });
    expect(await bodies()).toEqual(["once"]);
  });

  it("queues statements outside a transaction behind it, as one connection does", async () => {
    const order: string[] = [];
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const transaction = database.transaction(async (inside) => {
      await inside.query("INSERT INTO notes VALUES (1, 'inside')");
      await held;
      order.push("transaction ends");
    });
    // Begun before the outside read is sent.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const outside = bodies().then((rows) => {
      order.push("outside read");
      return rows;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(order).toEqual([]);
    release();
    await transaction;
    expect(await outside).toEqual(["inside"]);
    expect(order).toEqual(["transaction ends", "outside read"]);
  });

  it("drives Kysely's PGlite dialect unchanged, transactions and savepoints included", async () => {
    const db = new Kysely<{ notes: { id: number; body: string } }>({
      dialect: new PGliteDialect({ pglite: database }),
    });
    await db.transaction().execute(async (trx) => {
      await trx.insertInto("notes").values({ id: 1, body: "kept" }).execute();
    });
    await expect(
      db.transaction().execute(async (trx) => {
        await trx.insertInto("notes").values({ id: 2, body: "lost" }).execute();
        await sql`SELECT 1 / 0`.execute(trx);
      }),
    ).rejects.toMatchObject({ code: "22012" });
    const controlled = await db.startTransaction().execute();
    await controlled
      .insertInto("notes")
      .values({ id: 3, body: "outer" })
      .execute();
    const inner = await controlled.savepoint("inner").execute();
    await inner.insertInto("notes").values({ id: 4, body: "undone" }).execute();
    await inner.rollbackToSavepoint("inner").execute();
    await controlled.commit().execute();
    expect(
      (await db.selectFrom("notes").select("body").orderBy("id").execute()).map(
        (row) => row.body,
      ),
    ).toEqual(["kept", "outer"]);
  });

  it("refuses statements once closed, and fails what waits when the thread is lost", async () => {
    const waiting = database.query("SELECT pg_sleep(5)");
    lose(new Error("The database thread stopped"));
    await expect(waiting).rejects.toThrow("The database thread stopped");
    expect(database.closed).toBe(true);
    await expect(database.query("SELECT 1")).rejects.toThrow(
      "The database thread stopped",
    );

    const second = connect();
    await second.database.waitReady;
    await second.database.close();
    expect(second.database.closed).toBe(true);
    expect(second.pglite.closed).toBe(true);
    await expect(second.database.query("SELECT 1")).rejects.toThrow(
      "The database is closed",
    );
  });
});
