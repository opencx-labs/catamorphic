import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TableCompactor } from "./table-compaction.js";

describe("table compaction", () => {
  let pglite: PGlite;
  beforeEach(async () => {
    pglite = new PGlite();
    await pglite.exec(`
      CREATE SCHEMA desktop;
      CREATE TABLE desktop.workspace_states (project_id int PRIMARY KEY, state text NOT NULL);
      INSERT INTO desktop.workspace_states VALUES (1, repeat('x', 4000));
    `);
  });
  afterEach(async () => {
    await pglite.close();
  });

  /** Rewrites the one row in place, leaving a dead version each time. */
  const churn = async (times: number) => {
    for (let i = 0; i < times; i++)
      await pglite.query(
        // Incompressible, like a real snapshot: stored out of line (TOAST).
        "UPDATE desktop.workspace_states SET state = (SELECT string_agg(md5(random()::text || $1), '') FROM generate_series(1, 125)) WHERE project_id = 1",
        [String(i)],
      );
  };
  const size = async () =>
    Number(
      (
        await pglite.query<{ bytes: string }>(
          "SELECT pg_total_relation_size('desktop.workspace_states')::text AS bytes",
        )
      ).rows[0]?.bytes,
    );

  it("rewrites a table only once it grows far past its compacted size", async () => {
    const compactor = new TableCompactor(pglite, {
      tables: ["desktop.workspace_states", "desktop.missing"],
      floorBytes: 256 * 1024,
    });
    // Small: remembered, not rewritten.
    expect(await compactor.compact()).toEqual([]);
    await churn(400);
    const bloated = await size();
    expect(bloated).toBeGreaterThan(256 * 1024);
    const [compaction] = await compactor.compact();
    expect(compaction).toMatchObject({
      table: "desktop.workspace_states",
      bytesBefore: bloated,
    });
    expect(compaction?.bytesAfter).toBeLessThan(bloated / 4);
    expect(await size()).toBe(compaction?.bytesAfter);
    // The live row survives the rewrite.
    expect(
      (
        await pglite.query<{ n: number }>(
          "SELECT length(state) AS n FROM desktop.workspace_states",
        )
      ).rows,
    ).toEqual([{ n: 4000 }]);
    // Under four times its compacted size: left alone.
    await churn(2);
    expect(await compactor.compact()).toEqual([]);
  });

  it("shares a pass already running and stops cleanly", async () => {
    const compactor = new TableCompactor(pglite, {
      tables: ["desktop.workspace_states"],
      floorBytes: 1,
    });
    const first = compactor.compact();
    expect(compactor.compact()).toBe(first);
    expect(await first).toHaveLength(1);
    compactor.start({ intervalMs: 60_000 });
    await compactor.stop();
  });
});
