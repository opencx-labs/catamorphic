import { sql } from "kysely";
import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDatabase } from "../database.js";

const TEST_DATABASE_URL = process.env.DATABASE_URL ?? "";
const describeIf = TEST_DATABASE_URL ? describe : describe.skip;

afterEach(() => {
  vi.restoreAllMocks();
});

describeIf("a pool catamorphic owns", () => {
  it("survives the server ending an idle connection, and keeps serving", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = createDatabase({
      connectionString: TEST_DATABASE_URL,
      poolSize: 1,
    });
    const admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await admin.connect();
    try {
      // The only pooled connection goes back to the pool, idle.
      const before = await sql<{
        pid: number;
      }>`SELECT pg_backend_pid() AS pid`.execute(db);
      const pid = before.rows[0]?.pid;
      expect(pid).toBeTypeOf("number");
      // As a restart or a forced database drop would: 57P01. Without the
      // pool's listener this is an unhandled 'error' event, which fails
      // the run (and crashes a server).
      await admin.query("SELECT pg_terminate_backend($1)", [pid]);
      await vi.waitFor(
        () =>
          expect(warn).toHaveBeenCalledWith(
            expect.stringContaining("An idle database connection closed"),
          ),
        { timeout: 10_000, interval: 20 },
      );
      const after = await sql<{
        pid: number;
      }>`SELECT pg_backend_pid() AS pid`.execute(db);
      expect(after.rows[0]?.pid).not.toBe(pid);
    } finally {
      await admin.end();
      await db.destroy();
    }
  });
});
