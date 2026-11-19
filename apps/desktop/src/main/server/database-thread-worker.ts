import { parentPort, workerData } from "node:worker_threads";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { serveDatabase } from "./database-thread-server.js";

/**
 * The desktop's database, on a thread of its own (ADR 0339). PGlite is
 * Postgres compiled to WebAssembly: a statement runs to its end on the
 * thread that issued it, and on the main process's thread that is every
 * window's input waiting. Here it holds up only the next statement.
 */
if (!parentPort) throw new Error("The database thread needs its parent's port");
const options: { dataDir: string } = workerData;
serveDatabase({
  pglite: new PGlite(options.dataDir, { extensions: { pgcrypto } }),
  port: parentPort,
});
