import { once } from "node:events";
import { MessageChannel } from "node:worker_threads";
import { PGlite } from "@electric-sql/pglite";
import { Kysely, PGliteDialect, sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  connectDatabaseThread,
  type DatabaseThread,
} from "./database-thread.js";
import type {
  DatabaseReply,
  DatabaseRequest,
} from "./database-thread-protocol.js";
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
  const lostWith: Error[] = [];
  let stops = 0;
  const database = connectDatabaseThread({
    port: port1,
    lost: (listener) => {
      lose = listener;
    },
    stop: async () => {
      stops += 1;
      port1.close();
      port2.close();
    },
    onLost: (error) => lostWith.push(error),
  });
  return {
    database,
    pglite,
    lose: (error: Error) => lose(error),
    lostWith,
    stops: () => stops,
  };
}

/** A thread that answers only what a test lets it: its far end, by hand. */
function connectByHand(answers: ReadonlyArray<DatabaseRequest["type"]>) {
  const { port1, port2 } = new MessageChannel();
  const lostWith: Error[] = [];
  let stops = 0;
  port2.on("message", (request: DatabaseRequest) => {
    if (answers.includes(request.type))
      port2.postMessage({ id: request.id, type: "result", value: undefined });
  });
  const database = connectDatabaseThread({
    port: port1,
    lost: () => {},
    stop: async () => {
      stops += 1;
      port1.close();
      port2.close();
    },
    onLost: (error) => lostWith.push(error),
  });
  return {
    database,
    say: (reply: DatabaseReply) => port2.postMessage(reply),
    lostWith,
    stops: () => stops,
  };
}

let database: DatabaseThread;
let pglite: PGlite;
let lose: (error: Error) => void;
let lostWith: Error[];
let stops: () => number;
beforeEach(async () => {
  ({ database, pglite, lose, lostWith, stops } = connect());
  await database.waitReady;
  await database.exec(
    "CREATE TABLE notes (id integer PRIMARY KEY, body text NOT NULL, CONSTRAINT notes_body_key UNIQUE (body))",
  );
});
afterEach(async () => {
  await database.close().catch(() => {});
  // A thread a test lost left its database open.
  if (!pglite.closed) await pglite.close();
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

  it("fails what waits when the thread is lost, ends it, and tells its owner once", async () => {
    // Sent, and not answered yet.
    const waiting = database.query("SELECT 1");
    const stopped = new Error("The database thread stopped");
    lose(stopped);
    await expect(waiting).rejects.toThrow("The database thread stopped");
    expect(database.closed).toBe(true);
    await expect(database.query("SELECT 1")).rejects.toThrow(
      "The database thread stopped",
    );
    // The thread's exit follows its error.
    lose(new Error("The database thread stopped"));
    expect(lostWith).toEqual([stopped]);
    expect(stops()).toBe(1);
    await database.close();
    expect(stops()).toBe(1);
  });

  it("fails its first statement when the database never opens, and ends the thread", async () => {
    const unopened = connectByHand([]);
    unopened.say({
      type: "failed",
      error: {
        name: "Error",
        message: "The data folder is locked",
        fields: {},
      },
    });
    await expect(unopened.database.waitReady).rejects.toThrow(
      "The data folder is locked",
    );
    await expect(unopened.database.query("SELECT 1")).rejects.toThrow(
      "The data folder is locked",
    );
    expect(unopened.database.closed).toBe(true);
    expect(unopened.stops()).toBe(1);
    // Its owner hears that from the statement, not as a database lost.
    expect(unopened.lostWith).toEqual([]);
  });

  it("refuses statements once closing, and closes once however often it is asked", async () => {
    const closing = database.close();
    await expect(database.query("SELECT 1")).rejects.toThrow(
      "The database is closed",
    );
    await expect(database.transaction(async () => {})).rejects.toThrow(
      "The database is closed",
    );
    await Promise.all([closing, database.close()]);
    expect(database.closed).toBe(true);
    expect(pglite.closed).toBe(true);
    expect(stops()).toBe(1);
    await expect(database.query("SELECT 1")).rejects.toThrow(
      "The database is closed",
    );
    expect(lostWith).toEqual([]);
  });

  it("fails a statement sent behind the close that the thread never answered", async () => {
    const quiet = connectByHand(["begin", "close"]);
    quiet.say({ type: "ready" });
    await quiet.database.waitReady;
    let closing: Promise<void> | undefined;
    await expect(
      quiet.database.transaction(async (transaction) => {
        closing = quiet.database.close();
        // Its transaction is open, so it is sent; the thread ends first.
        await transaction.query("SELECT 1");
      }),
    ).rejects.toThrow("The database is closed");
    await closing;
    expect(quiet.stops()).toBe(1);
  });

  it("answers a commit for a transaction that is not open with an error, and a rollback with nothing", async () => {
    const { port1, port2 } = new MessageChannel();
    const served = new PGlite();
    serveDatabase({ pglite: served, port: port2 });
    const answerTo = async (request: DatabaseRequest) => {
      for (;;) {
        const [reply]: DatabaseReply[] = await once(port1, "message");
        if (reply && "id" in reply && reply.id === request.id) return reply;
      }
    };
    const commit: DatabaseRequest = { id: 1, type: "commit", transaction: 7 };
    const committed = answerTo(commit);
    port1.postMessage(commit);
    expect(await committed).toMatchObject({
      type: "error",
      error: { message: "The transaction has already ended" },
    });
    const rollback: DatabaseRequest = {
      id: 2,
      type: "rollback",
      transaction: 7,
    };
    const rolledBack = answerTo(rollback);
    port1.postMessage(rollback);
    expect(await rolledBack).toMatchObject({ type: "result" });
    port1.close();
    port2.close();
    await served.close();
  });

  it("answers what the channel cannot carry with an error, in either direction, and goes on", async () => {
    // A parameter that cannot be sent: nothing reaches the thread.
    await expect(
      database.query("SELECT $1::text AS body", [() => "a function"]),
    ).rejects.toThrow(/could not be cloned/);
    // A value that cannot be sent back.
    vi.spyOn(pglite, "query").mockResolvedValueOnce({
      rows: [() => "a function"],
      fields: [],
    });
    await expect(database.query("SELECT 1")).rejects.toThrow(
      /could not be cloned/,
    );
    vi.restoreAllMocks();
    // A statement's parameters stay on the thread when it fails.
    await database.query("INSERT INTO notes VALUES (1, $1)", ["once"]);
    const failure: unknown = await database
      .query("INSERT INTO notes VALUES (2, $1)", ["once"])
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "23505" });
    expect(failure).not.toHaveProperty("params");
    expect(await bodies()).toEqual(["once"]);
  });
});
