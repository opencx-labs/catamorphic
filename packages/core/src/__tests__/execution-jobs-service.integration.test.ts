import { createDatabase, migrateToLatest } from "@catamorphic/db";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ExecutionJobsService } from "../services/execution-jobs-service.js";
import { ExecutionWorkerService } from "../services/execution-worker-service.js";

const connectionString = process.env.DATABASE_URL ?? "";
const describeIf = connectionString ? describe : describe.skip;
const schema = `catamorphic_jobs_${crypto.randomUUID().replaceAll("-", "")}`;
const db = createDatabase({ connectionString, schema });
const jobs = new ExecutionJobsService(db);
const tenantId = crypto.randomUUID();

describeIf("ExecutionJobsService integration", () => {
  beforeAll(async () => {
    await migrateToLatest({ db, schema });
    await db
      .insertInto("tenants")
      .values({ id: tenantId, name: "Queue test tenant" })
      .execute();
  });

  afterAll(async () => {
    await sql.raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).execute(db);
    await db.destroy();
  });

  it("claims and completes jobs with a lease", async () => {
    const enqueued = await jobs.enqueue({
      tenantId,
      kind: "workflow_run",
      payload: { runId: crypto.randomUUID() },
      dedupeKey: `run:${crypto.randomUUID()}`,
    });
    const claimed = await jobs.claim({
      workerId: "worker-a",
      kinds: ["workflow_run"],
      leaseSeconds: 30,
    });

    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({
      id: enqueued.id,
      status: "running",
      leasedBy: "worker-a",
      attempt: 1,
    });
    expect(
      await jobs.complete({ jobId: enqueued.id, workerId: "worker-a" }),
    ).toBe(true);
  });

  it("deduplicates non-null keys but permits jobs without keys", async () => {
    const dedupeKey = `dedupe:${crypto.randomUUID()}`;
    const first = await jobs.enqueue({
      tenantId,
      kind: "batch_item",
      payload: { itemId: "first" },
      dedupeKey,
    });
    const duplicate = await jobs.enqueue({
      tenantId,
      kind: "batch_item",
      payload: { itemId: "second" },
      dedupeKey,
    });
    const unkeyed = await Promise.all([
      jobs.enqueue({
        tenantId,
        kind: "batch_source",
        payload: { page: 1 },
      }),
      jobs.enqueue({
        tenantId,
        kind: "batch_source",
        payload: { page: 2 },
      }),
    ]);

    expect(duplicate.id).toBe(first.id);
    expect(unkeyed[0]?.id).not.toBe(unkeyed[1]?.id);
  });

  it("requeues retryable failures and terminally fails exhausted jobs", async () => {
    const enqueued = await jobs.enqueue({
      tenantId,
      kind: "batch_sink",
      payload: { chunk: "one" },
      maxAttempts: 1,
      dedupeKey: `sink:${crypto.randomUUID()}`,
    });
    await jobs.claim({
      workerId: "worker-b",
      kinds: ["batch_sink"],
    });

    const status = await jobs.fail({
      jobId: enqueued.id,
      workerId: "worker-b",
      error: "sink failed",
    });
    expect(status).toBe("failed");
    expect(await jobs.redrive({ tenantId, jobId: enqueued.id })).toBe(true);
    const redriven = await jobs.claim({
      workerId: "worker-b-redrive",
      kinds: ["batch_sink"],
    });
    expect(redriven[0]).toMatchObject({
      id: enqueued.id,
      attempt: 1,
      status: "running",
    });
  });

  it("cancels all pending jobs under a batch prefix", async () => {
    const batchId = crypto.randomUUID();
    await Promise.all(
      ["one", "two"].map((suffix) =>
        jobs.enqueue({
          tenantId,
          kind: "batch_item",
          payload: { suffix },
          dedupeKey: `batch:${batchId}:${suffix}`,
        }),
      ),
    );
    const canceled = await jobs.cancelByDedupePrefix({
      tenantId,
      dedupePrefix: `batch:${batchId}:`,
    });
    expect(canceled).toBe(2);
  });

  it("runs registered handlers through the worker lifecycle", async () => {
    const worker = new ExecutionWorkerService(jobs);
    const handled = new Promise<string>((resolve) => {
      worker.registerHandler({
        kind: "workflow_run",
        handler: async ({ job }) => {
          resolve(job.id);
        },
      });
    });
    const enqueued = await jobs.enqueue({
      tenantId,
      kind: "workflow_run",
      payload: { runId: crypto.randomUUID() },
      dedupeKey: `worker:${crypto.randomUUID()}`,
    });
    const workerId = worker.start({
      workerId: "integration-worker",
      kinds: ["workflow_run"],
      pollIntervalMs: 5,
      leaseSeconds: 5,
    });

    await expect(
      Promise.race([
        handled,
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error("Worker timed out")), 2_000),
        ),
      ]),
    ).resolves.toBe(enqueued.id);
    expect(worker.stop({ workerId })).toBe(true);
  });
});
