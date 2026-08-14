import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type DB, DEFAULT_SCHEMA, migrateToLatest } from "@catamorphic/db";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { Kysely, PGliteDialect, sql, WithSchemaPlugin } from "kysely";
import { afterAll, describe, expect, it } from "vitest";
import { ExecutionJobsService } from "../services/execution-jobs-service.js";

/**
 * Power-loss durability on the desktop stack (PGlite on disk).
 *
 * The desktop app's durability story composes two claims: PGlite recovers to
 * the last committed write after the process dies without closing, and the
 * maintenance sweep turns the dead process's expired lease back into a
 * pending job with its attempt refunded. This test exercises both for real:
 * a child process claims a job and commits writes until it is SIGKILLed
 * mid-flight, then the reopened database must recover, requeue, and let the
 * job complete.
 */

const FIXTURE = fileURLToPath(
  new URL("./fixtures/pglite-crash-writer.mjs", import.meta.url),
);

// Three PGlite boots plus a full migration run; generous so parallel
// monorepo suites don't turn wasm startup into a flake.
const CRASH_TIMEOUT = 180_000;

const tenantId = crypto.randomUUID();
const projectId = crypto.randomUUID();
const runId = crypto.randomUUID();

async function openDb(dataDir: string): Promise<Kysely<DB>> {
  const db = new Kysely<DB>({
    dialect: new PGliteDialect({
      pglite: new PGlite(dataDir, { extensions: { pgcrypto } }),
    }),
    plugins: [new WithSchemaPlugin(DEFAULT_SCHEMA)],
  });
  // Mirrors boot.ts: raw-SQL paths (the worker's claim CTE) resolve tables
  // via search_path, not WithSchemaPlugin.
  await sql.raw(`SET search_path TO "${DEFAULT_SCHEMA}", public`).execute(db);
  return db;
}

/** Wait for a stdout line, or reject if the child exits first. */
function waitForLine(args: {
  child: ChildProcess;
  lines: string[];
  predicate: (line: string) => boolean;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    if (args.lines.some(args.predicate)) return resolve();
    const onData = () => {
      if (args.lines.some(args.predicate)) {
        cleanup();
        resolve();
      }
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`crash writer exited early (code ${code})`));
    };
    const cleanup = () => {
      args.child.stdout?.off("data", onData);
      args.child.off("exit", onExit);
    };
    args.child.stdout?.on("data", onData);
    args.child.on("exit", onExit);
  });
}

let tmpDir: string | undefined;

afterAll(async () => {
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("PGlite crash recovery", () => {
  it("recovers committed state and requeues the dead process's job", {
    timeout: CRASH_TIMEOUT,
  }, async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "catamorphic-crash-"));
    const dataDir = path.join(tmpDir, "db");

    // Phase 1: prepare the world the way boot.ts would, then close cleanly.
    const setupDb = await openDb(dataDir);
    await migrateToLatest({ db: setupDb });
    await setupDb
      .insertInto("tenants")
      .values({ id: tenantId, name: "crash-tenant" })
      .execute();
    await setupDb
      .insertInto("projects")
      .values({ id: projectId, tenant_id: tenantId, name: "crash-project" })
      .execute();
    await setupDb
      .insertInto("workflow_runs")
      .values({
        id: runId,
        project_id: projectId,
        workflow_name: "crash-recovery",
        provenance: sql`'{}'::jsonb`,
        status: "running",
      })
      .execute();
    const enqueued = await new ExecutionJobsService(setupDb).enqueue({
      tenantId,
      workflowRunId: runId,
      kind: "batch_item",
      payload: { probe: true },
    });
    await setupDb.destroy();

    // Phase 2: the child claims the job and commits writes until SIGKILL.
    const child = spawn(process.execPath, [FIXTURE, dataDir, enqueued.id], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    const lines: string[] = [];
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      lines.push(...chunk.split("\n").filter(Boolean));
    });
    await waitForLine({
      child,
      lines,
      predicate: (line) => line === "CLAIMED",
    });
    await waitForLine({
      child,
      lines,
      predicate: (line) => line === "TICK 3",
    });
    child.kill("SIGKILL");
    await new Promise((resolve) => child.on("exit", resolve));
    const committedTicks = lines.filter((line) =>
      line.startsWith("TICK "),
    ).length;
    expect(committedTicks).toBeGreaterThanOrEqual(3);

    // Phase 3: reopen the data dir as a fresh boot would.
    const db = await openDb(dataDir);
    try {
      // Every write the child saw commit survived the SIGKILL.
      const ticks = await db
        .selectFrom("tenants")
        .select(db.fn.countAll<string>().as("count"))
        .where("name", "like", "tick-%")
        .executeTakeFirstOrThrow();
      expect(Number(ticks.count)).toBeGreaterThanOrEqual(committedTicks);

      // The dead process left the job running with a lease that has expired.
      const stranded = await db
        .selectFrom("execution_jobs")
        .select(["status", "leased_by", "attempt"])
        .where("id", "=", enqueued.id)
        .executeTakeFirstOrThrow();
      expect(stranded.status).toBe("running");
      expect(stranded.leased_by).toBe("crash-worker");
      expect(stranded.attempt).toBe(1);

      // The 1-second lease may still be live if boot was fast; the sweep
      // is what recovers it, exactly as the worker's first poll would.
      const jobs = new ExecutionJobsService(db);
      const deadline = Date.now() + 15_000;
      let requeued = 0;
      while (requeued === 0 && Date.now() < deadline) {
        requeued = await jobs.requeueExpired({});
        if (requeued === 0) {
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      }
      expect(requeued).toBe(1);

      // Crash charged no attempt; the job is claimable and completable.
      const recovered = await db
        .selectFrom("execution_jobs")
        .select(["status", "attempt", "lease_expiries"])
        .where("id", "=", enqueued.id)
        .executeTakeFirstOrThrow();
      expect(recovered.status).toBe("pending");
      expect(recovered.attempt).toBe(0);
      expect(recovered.lease_expiries).toBe(1);

      const [claimed] = await jobs.claim({
        workerId: "recovery-worker",
        kinds: ["batch_item"],
        limit: 1,
      });
      expect(claimed?.id).toBe(enqueued.id);
      if (!claimed) throw new Error("reclaim failed");
      expect(
        await jobs.complete({
          jobId: claimed.id,
          workerId: "recovery-worker",
          leaseToken: claimed.leaseToken ?? "",
          leaseGeneration: claimed.leaseGeneration,
        }),
      ).toBe(true);
    } finally {
      await db.destroy();
    }
  });
});
