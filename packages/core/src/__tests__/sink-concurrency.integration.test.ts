import { createDatabase, migrateToLatest } from "@catamorphic/db";
import type {
  RuntimeInvocation,
  RuntimeInvocationReceipt,
} from "@catamorphic/sandbox";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BatchExecutionHandler } from "../services/batch-execution-handler.js";
import {
  type ExecutionJob,
  ExecutionJobsService,
} from "../services/execution-jobs-service.js";
import type {
  ExecutionJobHandler,
  ExecutionWorkerService,
} from "../services/execution-worker-service.js";
import { RunCoordinator } from "../services/run-coordinator.js";

const connectionString = process.env.DATABASE_URL ?? "";
const describeIf = connectionString ? describe : describe.skip;
const schema = `catamorphic_sink_${crypto.randomUUID().replaceAll("-", "")}`;
const db = createDatabase({ connectionString, schema, poolSize: 8 });
const jobs = new ExecutionJobsService(db);
const coordinator = new RunCoordinator(db, jobs);

const tenantId = crypto.randomUUID();
const projectId = crypto.randomUUID();
const artifactId = crypto.randomUUID();

/** Mutated per test to shape the stub sink the runtime "loads". */
const sinkSpec = {
  hasInitialize: false,
  concurrency: undefined as number | undefined,
  writeBatchReturnsState: false,
};

interface SinkCall {
  operation: string;
  chunkKey?: string;
  statePresent: boolean;
}
let sinkCalls: SinkCall[] = [];

const handlers = new Map<string, ExecutionJobHandler>();
const fakeWorker = {
  registerHandler: (args: { kind: string; handler: ExecutionJobHandler }) => {
    handlers.set(args.kind, args.handler);
  },
} as unknown as ExecutionWorkerService;

function receipt(args: {
  invocationId: string;
  result: unknown;
}): RuntimeInvocationReceipt {
  return {
    runtimeId: "runtime-1",
    invocationId: args.invocationId,
    events: [],
    terminal: { status: "completed", result: args.result, steps: [] },
  } as unknown as RuntimeInvocationReceipt;
}

new BatchExecutionHandler(db, {
  coordinator,
  jobs,
  rateReservations: {} as never,
  worker: fakeWorker,
  invokeRuntime: async (args: {
    invocationId: string;
    kind: RuntimeInvocation["kind"];
    operation?: string;
    input: unknown;
  }) => {
    if (args.kind !== "batch-sink") {
      throw new Error(`Unexpected invocation kind '${args.kind}'`);
    }
    const input = args.input as Record<string, unknown>;
    sinkCalls.push({
      operation: args.operation ?? "",
      chunkKey: typeof input.chunkKey === "string" ? input.chunkKey : undefined,
      statePresent: Object.hasOwn(input, "state"),
    });
    if (args.operation === "inspect") {
      return receipt({
        invocationId: args.invocationId,
        result: {
          present: true,
          hasInitialize: sinkSpec.hasInitialize,
          ...(sinkSpec.concurrency === undefined
            ? {}
            : { concurrency: sinkSpec.concurrency }),
        },
      });
    }
    if (args.operation === "initialize") {
      return receipt({
        invocationId: args.invocationId,
        result: { written: 0 },
      });
    }
    if (args.operation === "writeBatch") {
      const records = input.records as ReadonlyArray<{ key: string }>;
      return receipt({
        invocationId: args.invocationId,
        result: {
          acknowledgedKeys: records.map((entry) => entry.key),
          ...(sinkSpec.writeBatchReturnsState ? { state: { written: 1 } } : {}),
        },
      });
    }
    if (args.operation === "finalize") {
      return receipt({
        invocationId: args.invocationId,
        result: { done: true },
      });
    }
    throw new Error(`Unexpected sink operation '${args.operation}'`);
  },
});

/**
 * Seeds a completed batch run parked at the sink boundary: every item
 * succeeded, the source is done, and a `sink:start` job is queued — exactly
 * the state finalizeIfComplete leaves behind.
 */
async function seedSinkReadyRun(args: { items: number }): Promise<{
  runId: string;
  attemptId: string;
}> {
  const runId = crypto.randomUUID();
  const attemptId = crypto.randomUUID();
  await db
    .insertInto("workflow_runs")
    .values({
      id: runId,
      project_id: projectId,
      workflow_name: "sinky",
      provenance: sql`jsonb_build_object('commitSha', ${"a".repeat(40)}::text)`,
      deployment_artifact_id: artifactId,
      external_user_id: "user-1",
      status: "running",
      phase: "process",
    })
    .execute();
  await db
    .insertInto("workflow_step_attempts")
    .values({
      id: attemptId,
      run_id: runId,
      step_index: 0,
      step_node_id: "batch-0",
      executor: "batch",
      attempt: 1,
      status: "running",
      input: sql`'{}'::jsonb`,
    })
    .execute();
  await db
    .insertInto("workflow_run_states")
    .values({
      run_id: runId,
      execution_plan: sql`'{"exportTarget":{"modulePath":"index.ts","exportName":"sinky"},"steps":[]}'::jsonb`,
      active_workflow_step_attempt_id: attemptId,
    })
    .execute();
  await db
    .insertInto("batch_execution_states")
    .values({
      run_id: runId,
      workflow_step_attempt_id: attemptId,
      discovered_count: String(args.items),
      completed_count: String(args.items),
      source_done: true,
    })
    .execute();
  await db
    .insertInto("batch_items")
    .values(
      Array.from({ length: args.items }, (_, index) => ({
        run_id: runId,
        workflow_step_attempt_id: attemptId,
        item_key: `item-${index}`,
        source_order: String(index),
        value: sql`'{}'::jsonb`,
        status: "succeeded",
        output: sql`'"ok"'::jsonb`,
        completed_at: new Date(),
      })),
    )
    .execute();
  await jobs.enqueue({
    tenantId,
    workflowRunId: runId,
    workflowStepAttemptId: attemptId,
    kind: "batch_sink",
    payload: { operation: "start" },
    dedupeKey: `run:${runId}:step-attempt:${attemptId}:sink:start`,
  });
  return { runId, attemptId };
}

/** Claims every due batch_sink job, mirroring one worker poll. */
async function claimSinkJobs(): Promise<ExecutionJob[]> {
  return jobs.claim({
    workerId: "sink-worker",
    kinds: ["batch_sink"],
    limit: 10,
    leaseSeconds: 30,
  });
}

/** Runs one claimed job through the registered handler and settles it. */
async function runJob(job: ExecutionJob): Promise<{ error?: string }> {
  const handler = handlers.get(job.kind);
  if (!handler) throw new Error(`No handler for '${job.kind}'`);
  try {
    await handler({ job, signal: new AbortController().signal });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await jobs.fail({
      jobId: job.id,
      workerId: "sink-worker",
      leaseToken: job.leaseToken ?? "",
      leaseGeneration: job.leaseGeneration,
      error: message,
    });
    return { error: message };
  }
  await jobs.complete({
    jobId: job.id,
    workerId: "sink-worker",
    leaseToken: job.leaseToken ?? "",
    leaseGeneration: job.leaseGeneration,
  });
  return {};
}

function payloadOf(job: ExecutionJob): Record<string, unknown> {
  return job.payload as Record<string, unknown>;
}

describeIf("sink write concurrency", () => {
  beforeAll(async () => {
    await migrateToLatest({ db, schema });
    await db
      .insertInto("tenants")
      .values({ id: tenantId, name: "T" })
      .execute();
    await db
      .insertInto("projects")
      .values({ id: projectId, tenant_id: tenantId, name: "P" })
      .execute();
    await db
      .insertInto("deployment_artifacts")
      .values({
        id: artifactId,
        project_id: projectId,
        commit_sha: "a".repeat(40),
        artifact_digest: "b".repeat(64),
        plugin_digest: "c".repeat(64),
        transform_version: "v1",
        runtime_version: "v1",
        status: "ready",
      })
      .execute();
  }, 120_000);

  afterAll(async () => {
    await sql.raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).execute(db);
    await db.destroy();
  });

  it("fans out chunks up to the declared concurrency and gates finalize on completion", async () => {
    sinkSpec.hasInitialize = false;
    sinkSpec.concurrency = 2;
    sinkSpec.writeBatchReturnsState = false;
    sinkCalls = [];
    // 250 items → 3 chunks at SINK_CHUNK_SIZE=100.
    const { runId, attemptId } = await seedSinkReadyRun({ items: 250 });

    const [start] = await claimSinkJobs();
    expect(payloadOf(start!).operation).toBe("start");
    expect((await runJob(start!)).error).toBeUndefined();

    const state = await db
      .selectFrom("batch_execution_states")
      .where("run_id", "=", runId)
      .select(["sink_concurrency", "sink_total_chunks"])
      .executeTakeFirstOrThrow();
    expect(state.sink_concurrency).toBe(2);
    expect(Number(state.sink_total_chunks)).toBe(3);

    // The window is bounded by concurrency: exactly 2 of 3 chunks enqueued.
    const firstWave = await claimSinkJobs();
    expect(firstWave.map((job) => payloadOf(job).operation).sort()).toEqual([
      "write",
      "write",
    ]);
    for (const job of firstWave) {
      expect((await runJob(job)).error).toBeUndefined();
    }

    // Both completions topped the window back up; the third chunk is due but
    // finalize is not — one chunk is still incomplete.
    const secondWave = await claimSinkJobs();
    expect(secondWave.map((job) => payloadOf(job).operation)).toEqual([
      "write",
    ]);
    expect((await runJob(secondWave[0]!)).error).toBeUndefined();

    const finalWave = await claimSinkJobs();
    expect(finalWave.map((job) => payloadOf(job).operation)).toEqual([
      "finalize",
    ]);
    expect((await runJob(finalWave[0]!)).error).toBeUndefined();

    // A concurrent sink never receives state.
    const writes = sinkCalls.filter((call) => call.operation === "writeBatch");
    expect(writes).toHaveLength(3);
    expect(writes.every((call) => !call.statePresent)).toBe(true);
    expect(new Set(writes.map((call) => call.chunkKey)).size).toBe(3);

    const attempt = await db
      .selectFrom("workflow_step_attempts")
      .where("id", "=", attemptId)
      .select(["status", "output"])
      .executeTakeFirstOrThrow();
    expect(attempt.status).toBe("completed");
    expect(attempt.output).toMatchObject({ artifact: { done: true } });
  }, 30_000);

  it("counts in-flight chunks before topping up the concurrency window", async () => {
    sinkSpec.hasInitialize = false;
    sinkSpec.concurrency = 2;
    sinkSpec.writeBatchReturnsState = false;
    sinkCalls = [];
    // 500 items -> 5 chunks, leaving enough pending work to expose an
    // overfill after only one writer in the first wave completes.
    await seedSinkReadyRun({ items: 500 });

    const [start] = await claimSinkJobs();
    expect((await runJob(start!)).error).toBeUndefined();

    const firstWave = await claimSinkJobs();
    expect(firstWave).toHaveLength(2);
    const siblingChunkId = payloadOf(firstWave[1]!).chunkId;
    expect(typeof siblingChunkId).toBe("string");
    // Mirror the sibling handler having started its write while this handler
    // completes. Its execution job and chunk both remain in flight.
    await db
      .updateTable("batch_sink_chunks")
      .set({ status: "running" })
      .where("id", "=", String(siblingChunkId))
      .execute();
    expect((await runJob(firstWave[0]!)).error).toBeUndefined();

    // The second first-wave job still owns one slot, so completing its sibling
    // may enqueue only one replacement.
    const replacement = await claimSinkJobs();
    expect(replacement).toHaveLength(1);
    expect(payloadOf(replacement[0]!).operation).toBe("write");
  }, 30_000);

  it("keeps an undeclared sink strictly serial", async () => {
    sinkSpec.hasInitialize = false;
    sinkSpec.concurrency = undefined;
    sinkSpec.writeBatchReturnsState = false;
    sinkCalls = [];
    const { runId } = await seedSinkReadyRun({ items: 250 });

    const [start] = await claimSinkJobs();
    expect((await runJob(start!)).error).toBeUndefined();
    const state = await db
      .selectFrom("batch_execution_states")
      .where("run_id", "=", runId)
      .select("sink_concurrency")
      .executeTakeFirstOrThrow();
    expect(state.sink_concurrency).toBe(1);

    // One chunk at a time, three times over.
    for (let round = 0; round < 3; round += 1) {
      const wave = await claimSinkJobs();
      expect(wave.map((job) => payloadOf(job).operation)).toEqual(["write"]);
      expect((await runJob(wave[0]!)).error).toBeUndefined();
    }
    const finalWave = await claimSinkJobs();
    expect(finalWave.map((job) => payloadOf(job).operation)).toEqual([
      "finalize",
    ]);
  }, 30_000);

  it("rejects a stateful sink that declares concurrency", async () => {
    sinkSpec.hasInitialize = true;
    sinkSpec.concurrency = 2;
    sinkSpec.writeBatchReturnsState = false;
    sinkCalls = [];
    await seedSinkReadyRun({ items: 10 });

    const [start] = await claimSinkJobs();
    const outcome = await runJob(start!);
    expect(outcome.error).toContain("cannot declare concurrency > 1");
    // The failure happened before initialize — the sink was never touched
    // beyond inspection.
    expect(sinkCalls.map((call) => call.operation)).toEqual(["inspect"]);
  }, 30_000);

  it("fails a chunk whose concurrent sink returns state anyway", async () => {
    sinkSpec.hasInitialize = false;
    sinkSpec.concurrency = 2;
    sinkSpec.writeBatchReturnsState = true;
    sinkCalls = [];
    const { runId } = await seedSinkReadyRun({ items: 10 });

    const [start] = await claimSinkJobs();
    expect((await runJob(start!)).error).toBeUndefined();
    const [write] = await claimSinkJobs();
    expect(payloadOf(write!).operation).toBe("write");
    const outcome = await runJob(write!);
    expect(outcome.error).toContain("must not return state");

    // The chunk was not marked completed and no state leaked into the row.
    const chunk = await db
      .selectFrom("batch_sink_chunks")
      .where("run_id", "=", runId)
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(chunk.status).not.toBe("completed");
    const state = await db
      .selectFrom("batch_execution_states")
      .where("run_id", "=", runId)
      .select("sink_state_present")
      .executeTakeFirstOrThrow();
    expect(state.sink_state_present).toBe(false);
  }, 30_000);
});
