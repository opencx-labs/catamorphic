import path from "node:path";
import { Worker } from "node:worker_threads";
import type { PGlite, Results } from "@electric-sql/pglite";
import type {
  DatabaseFailure,
  DatabaseReply,
  DatabaseRequest,
} from "./database-thread-protocol.js";

/** A request before it is numbered, kind by kind. */
type Statement = DatabaseRequest extends infer Request
  ? Request extends unknown
    ? Omit<Request, "id">
    : never
  : never;

/** A transaction on the database's thread. */
export interface DatabaseThreadTransaction {
  query<T>(
    sql: string,
    params?: unknown[],
    options?: { rowMode?: "array" | "object" },
  ): Promise<Results<T>>;
  exec(sql: string): Promise<Array<Results>>;
  rollback(): Promise<void>;
}

/**
 * The desktop's database as its callers know it: what they use of PGlite
 * (`query`, `exec`, a transaction, `close`), answered by the database's own
 * thread (`database-thread-worker.ts`).
 */
export interface DatabaseThread extends Pick<PGlite, "query" | "exec"> {
  readonly closed: boolean;
  readonly ready: boolean;
  readonly waitReady: Promise<void>;
  transaction<T>(
    callback: (transaction: DatabaseThreadTransaction) => Promise<T>,
  ): Promise<T>;
  close(): Promise<void>;
}

/** A reply's value is what PGlite returned on the other thread. */
function isResults<T>(value: unknown): value is Results<T> {
  return typeof value === "object" && value !== null && "rows" in value;
}
function results<T>(value: unknown): Results<T> {
  if (!isResults<T>(value))
    throw new Error("The database answered with something unreadable");
  return value;
}
function isResultList(value: unknown): value is Array<Results> {
  return Array.isArray(value) && value.every((each) => isResults(each));
}
function resultList(value: unknown): Array<Results> {
  if (!isResultList(value))
    throw new Error("The database answered with something unreadable");
  return value;
}

function raised(failure: DatabaseFailure): Error {
  const error = Object.assign(new Error(failure.message), failure.fields);
  error.name = failure.name;
  // Where the statement failed in the database, then who issued it.
  if (failure.stack) error.stack = `${failure.stack}\n${error.stack ?? ""}`;
  return error;
}

/** The end of the channel the database's callers ask on. */
export interface DatabaseClientPort {
  postMessage(request: DatabaseRequest): void;
  on(event: "message", listener: (reply: DatabaseReply) => void): unknown;
}

/**
 * The database behind a channel (`serveDatabase` answers the other end).
 * `lost` reports the other end going away without being asked to; `stop`
 * ends it once the database has closed.
 */
export function connectDatabaseThread({
  port,
  lost,
  stop,
}: {
  port: DatabaseClientPort;
  lost: (listener: (error: Error) => void) => void;
  stop: () => Promise<unknown>;
}): DatabaseThread {
  const waiting = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  let nextRequest = 1;
  let nextTransaction = 1;
  let closed = false;
  let ready = false;
  let gone: Error | undefined;
  let becameReady: () => void = () => {};
  let failedToOpen: (error: Error) => void = () => {};
  const waitReady = new Promise<void>((resolve, reject) => {
    becameReady = resolve;
    failedToOpen = reject;
  });
  // Nobody may be waiting yet when the database fails to open.
  waitReady.catch(() => {});
  const lose = (error: Error) => {
    if (closed) return;
    gone = error;
    closed = true;
    failedToOpen(error);
    for (const request of waiting.values()) request.reject(error);
    waiting.clear();
  };
  lost(lose);
  port.on("message", (reply) => {
    if (reply.type === "ready") {
      ready = true;
      becameReady();
      return;
    }
    if (reply.type === "failed") {
      lose(raised(reply.error));
      return;
    }
    const request = waiting.get(reply.id);
    waiting.delete(reply.id);
    if (reply.type === "result") request?.resolve(reply.value);
    else request?.reject(raised(reply.error));
  });

  function ask<T>(statement: Statement, read: (value: unknown) => T) {
    return new Promise<T>((resolve, reject) => {
      if (closed) {
        reject(gone ?? new Error("The database is closed"));
        return;
      }
      const id = nextRequest++;
      waiting.set(id, { resolve: (value) => resolve(read(value)), reject });
      port.postMessage({ ...statement, id });
    });
  }
  const nothing = () => undefined;
  const statements = (transaction?: number) => ({
    query: <T>(
      sql: string,
      params?: unknown[],
      options?: { rowMode?: "array" | "object" },
    ) =>
      ask(
        {
          type: "query",
          sql,
          ...(params ? { params } : {}),
          ...(options?.rowMode ? { rowMode: options.rowMode } : {}),
          ...(transaction === undefined ? {} : { transaction }),
        },
        results<T>,
      ),
    exec: (sql: string) =>
      ask(
        {
          type: "exec",
          sql,
          ...(transaction === undefined ? {} : { transaction }),
        },
        resultList,
      ),
  });

  return {
    ...statements(),
    get closed() {
      return closed;
    },
    get ready() {
      return ready;
    },
    waitReady,
    async transaction(callback) {
      const transaction = nextTransaction++;
      await ask({ type: "begin", transaction }, nothing);
      let rolledBack = false;
      try {
        const result = await callback({
          ...statements(transaction),
          rollback: async () => {
            rolledBack = true;
            await ask({ type: "rollback", transaction }, nothing);
          },
        });
        if (!rolledBack) await ask({ type: "commit", transaction }, nothing);
        return result;
      } catch (error) {
        if (!rolledBack)
          await ask({ type: "rollback", transaction }, nothing).catch(nothing);
        throw error;
      }
    },
    async close() {
      if (closed) return;
      await ask({ type: "close" }, nothing);
      closed = true;
      await stop();
    },
  };
}

/** Open the database at `dataDir` on a thread of its own. */
export function openDatabaseThread(dataDir: string): DatabaseThread {
  // The worker is an entry of the main build, beside `index.js`; this
  // module may be bundled into a chunk one folder below it.
  const here = import.meta.dirname;
  const worker = new Worker(
    path.join(
      path.basename(here) === "chunks" ? path.dirname(here) : here,
      "database-thread-worker.js",
    ),
    { workerData: { dataDir }, name: "Work Database" },
  );
  return connectDatabaseThread({
    port: worker,
    lost: (listener) => {
      worker.on("error", listener);
      worker.on("exit", () =>
        listener(new Error("The database thread stopped")),
      );
    },
    stop: () => worker.terminate(),
  });
}
