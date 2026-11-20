import type { PGlite, Transaction } from "@electric-sql/pglite";
import type {
  DatabaseFailure,
  DatabaseReply,
  DatabaseRequest,
} from "./database-thread-protocol.js";

/** The end of the channel the database answers on. */
export interface DatabaseServerPort {
  postMessage(reply: DatabaseReply): void;
  on(event: "message", listener: (request: DatabaseRequest) => void): unknown;
}

function failure(error: unknown): DatabaseFailure {
  if (!(error instanceof Error))
    return { name: "Error", message: String(error), fields: {} };
  // A Postgres error's code, constraint and detail are own properties, and
  // plain values. PGlite also hangs the statement's parameters on it: they
  // can be megabytes, or something no channel can carry, and stay here.
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(error))
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      typeof value === "bigint"
    )
      fields[key] = value;
  return {
    name: error.name,
    message: error.message,
    ...(error.stack ? { stack: error.stack } : {}),
    fields,
  };
}

/**
 * Answer a channel's requests from `pglite`: statements, and transactions
 * held open here for the statements the other end sends into them. PGlite
 * runs one transaction at a time and queues everything else behind it, so
 * order and isolation are what they were with one caller on one thread.
 */
export function serveDatabase({
  pglite,
  port,
}: {
  pglite: PGlite;
  port: DatabaseServerPort;
}): void {
  const open = new Map<
    number,
    {
      transaction: Transaction;
      end: (outcome: "commit" | "rollback") => void;
      closed: Promise<void>;
    }
  >();

  const begin = (id: number) =>
    new Promise<void>((begun, refused) => {
      let end: (outcome: "commit" | "rollback") => void = () => {};
      const ended = new Promise<"commit" | "rollback">((resolve) => {
        end = resolve;
      });
      const closed: Promise<void> = pglite
        .transaction(async (transaction) => {
          open.set(id, { transaction, end, closed });
          begun();
          if ((await ended) === "rollback") await transaction.rollback();
        })
        .finally(() => open.delete(id));
      // One that never began (the database closed) is the caller's to hear.
      closed.catch(refused);
    });

  const handle = async (request: DatabaseRequest): Promise<unknown> => {
    if (request.type === "close") return pglite.close();
    if (request.type === "begin") return begin(request.transaction);
    if (request.type === "commit" || request.type === "rollback") {
      const held = open.get(request.transaction);
      if (!held) {
        // Nothing is left to roll back; nothing was committed either.
        if (request.type === "rollback") return undefined;
        throw new Error("The transaction has already ended");
      }
      held.end(request.type);
      return held.closed;
    }
    const target =
      request.transaction === undefined
        ? pglite
        : open.get(request.transaction)?.transaction;
    if (!target) throw new Error("The transaction has already ended");
    if (request.type === "exec") return target.exec(request.sql);
    return target.query(request.sql, request.params, {
      rowMode: request.rowMode ?? "object",
    });
  };

  // Every request is answered: one left waiting holds its caller, and
  // behind a Kysely caller every statement after it.
  const refuse = (id: number, error: unknown) =>
    port.postMessage({ id, type: "error", error: failure(error) });
  port.on("message", (request) => {
    handle(request).then(
      (value) => {
        try {
          port.postMessage({ id: request.id, type: "result", value });
        } catch (error) {
          // A value the channel cannot carry.
          refuse(request.id, error);
        }
      },
      (error: unknown) => refuse(request.id, error),
    );
  });
  pglite.waitReady.then(
    () => port.postMessage({ type: "ready" }),
    (error: unknown) =>
      port.postMessage({ type: "failed", error: failure(error) }),
  );
}
