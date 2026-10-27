import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createDatabase,
  type DB,
  migrateToLatest,
  withStorableParameters,
} from "@catamorphic/db";
import { FsBackend, FsRemoteBackend, ProjectManager } from "@catamorphic/git";
import type { WorkflowExecutionDescriptor } from "@catamorphic/parser";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { Kysely, PGliteDialect, sql, WithSchemaPlugin } from "kysely";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { CatamorphicCore } from "../core.js";
import type { Identity } from "../identity.js";
import { AccessDeniedError } from "../services/artifact-scope.js";
import { ExecutionJobsService } from "../services/execution-jobs-service.js";
import {
  RunCoordinator,
  RunResumeConflictError,
} from "../services/run-coordinator.js";
import {
  RUN_SIGNAL_MAX_PENDING,
  RUN_SIGNAL_MAX_RECEIPTS,
  RunSignalInvalidError,
  RunSignalLimitError,
  RunSignalNotFoundError,
} from "../services/run-signals.js";

import { testEnvironmentProvider } from "./test-environment.js";

for (const backend of ["postgres", "pglite"] as const) {
  const connectionString = process.env.DATABASE_URL ?? "";
  const describeBackend =
    backend === "postgres" && !connectionString ? describe.skip : describe;
  describeBackend(`durable named signals (${backend})`, () => {
    const schema = `signals_${crypto.randomUUID().replaceAll("-", "")}`;
    const tenantId = crypto.randomUUID();
    const projectId = crypto.randomUUID();
    const identity: Identity = { tenantId, externalUserId: "signal-owner" };
    const db =
      backend === "postgres"
        ? createDatabase({ connectionString, schema, poolSize: 12 })
        : withStorableParameters(
            new Kysely<DB>({
              dialect: new PGliteDialect({
                pglite: new PGlite({ extensions: { pgcrypto } }),
              }),
              plugins: [new WithSchemaPlugin(schema)],
            }),
          );
    const jobs = new ExecutionJobsService(db);
    const coordinator = new RunCoordinator(db, jobs);
    // A second replica deliberately has no process-local inbox state.
    const replica = new RunCoordinator(db, new ExecutionJobsService(db));
    let core: CatamorphicCore;
    let directory = "";

    beforeAll(async () => {
      await migrateToLatest({ db, schema });
      await db
        .insertInto("tenants")
        .values({ id: tenantId, name: "Signals" })
        .execute();
      await db
        .insertInto("projects")
        .values({ id: projectId, tenant_id: tenantId, name: "Signals" })
        .execute();
      directory = await fs.mkdtemp(
        path.join(os.tmpdir(), "catamorphic-signals-"),
      );
      core = new CatamorphicCore({
        db,
        environmentProvider: testEnvironmentProvider(),
        projectManager: new ProjectManager(
          new FsBackend(path.join(directory, "draft")),
          new FsRemoteBackend(path.join(directory, "remote")),
        ),
      });
    }, 120_000);
    beforeEach(async () => {
      await db.deleteFrom("workflow_runs").execute();
    });
    afterAll(async () => {
      await core?.runs.stopWorkers();
      await sql.raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).execute(db);
      await db.destroy();
      if (directory) await fs.rm(directory, { recursive: true, force: true });
    });

    async function run() {
      const runId = crypto.randomUUID();
      const correlationKey = "subject";
      await db.transaction().execute(async (trx) => {
        await trx
          .insertInto("workflow_runs")
          .values({
            id: runId,
            project_id: projectId,
            workflow_name: "journey",
            correlation_key: correlationKey,
            external_user_id: identity.externalUserId,
            provenance: { commitSha: "a".repeat(40) },
            status: "pending",
          })
          .execute();
        const range = {
          start: 0,
          end: 1,
          startLine: 1,
          endLine: 1,
          startColumn: 1,
          endColumn: 2,
        };
        const execution: WorkflowExecutionDescriptor = {
          exportTarget: { modulePath: "index.ts", exportName: "journey" },
          steps: [0, 1, 2].map((index) => ({
            type: "boundary",
            topLevelIndex: index,
            nodeId: `step-${index}`,
            sourceRange: range,
            runRange: range,
            retry: {},
          })),
        };
        await coordinator.initialize({
          trx,
          tenantId,
          runId,
          execution,
          input: {},
        });
      });
      return {
        identity,
        projectId,
        workflowName: "journey",
        correlationKey,
        runId,
      };
    }

    async function preparePause(args: { runId: string }) {
      const [job] = await jobs.claim({
        workerId: "signals",
        kinds: ["durable_boundary"],
        limit: 1,
        leaseSeconds: 60,
      });
      if (!job || job.workflowRunId !== args.runId)
        throw new Error("Expected this run's boundary");
      expect(await coordinator.beginAttempt({ job, phase: "boundary" })).toBe(
        true,
      );
      return async (
        transition: Record<string, unknown> = { signal: "reply" },
      ) => {
        await coordinator.suspendForPause({
          workflowStepAttemptId: job.workflowStepAttemptId ?? "",
          job,
          transition: {
            ...transition,
            statePresent: true,
            state: { preserved: true },
          },
        });
        await jobs.complete({
          jobId: job.id,
          workerId: "signals",
          leaseToken: job.leaseToken ?? "",
          leaseGeneration: job.leaseGeneration,
        });
        return db
          .selectFrom("workflow_pauses")
          .where(
            "workflow_step_attempt_id",
            "=",
            job.workflowStepAttemptId ?? "",
          )
          .selectAll()
          .executeTakeFirstOrThrow();
      };
    }

    const event = {
      signal: "reply",
      idempotencyKey: "event-1",
      value: { approved: true },
    };

    it("buffers callback-before-wait, consumes once, and keeps pause state", async () => {
      const target = await run();
      const early = await core.runs.signalByKey({ ...target, ...event });
      expect(early).toMatchObject({
        runId: target.runId,
        status: "buffered",
        pauseId: null,
      });
      const open = await preparePause(target);
      const pause = await open();
      expect(pause).toMatchObject({
        status: "resumed",
        resume_value: event.value,
      });
      const retry = await core.runs.signalByKey({ ...target, ...event });
      expect(retry).toEqual({ ...early, status: "resumed", pauseId: pause.id });
      const first = await db
        .selectFrom("workflow_step_attempts")
        .where("id", "=", pause.workflow_step_attempt_id)
        .selectAll()
        .executeTakeFirstOrThrow();
      expect(first.output).toEqual({
        reason: "resumed",
        value: event.value,
        state: { preserved: true },
      });
      expect(
        (await db.selectFrom("workflow_signals").selectAll().execute())[0]
          ?.value,
      ).toBeNull();
      expect(
        await db
          .selectFrom("workflow_step_attempts")
          .where("step_index", "=", 1)
          .selectAll()
          .execute(),
      ).toHaveLength(1);
    });

    it("serializes replica sends against pause creation and duplicate delivery", async () => {
      const target = await run();
      const open = await preparePause(target);
      await Promise.all([
        open(),
        ...Array.from({ length: 16 }, (_, index) =>
          (index % 2 ? coordinator : replica).signalByKey({
            ...target,
            ...event,
          }),
        ),
      ]);
      expect(
        await db
          .selectFrom("workflow_pauses")
          .select("status")
          .executeTakeFirst(),
      ).toEqual({ status: "resumed" });
      const rows = await db
        .selectFrom("workflow_signals")
        .selectAll()
        .execute();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe("resumed");
      expect(
        await db
          .selectFrom("workflow_step_attempts")
          .where("step_index", "=", 1)
          .selectAll()
          .execute(),
      ).toHaveLength(1);
    });

    it("resumes a stateless named pause without persisting JSON null as state", async () => {
      const target = await run();
      await coordinator.signalByKey({ ...target, ...event });
      const [job] = await jobs.claim({
        workerId: "stateless",
        kinds: ["durable_boundary"],
        limit: 1,
        leaseSeconds: 60,
      });
      if (!job) throw new Error("Expected boundary");
      await coordinator.beginAttempt({ job, phase: "boundary" });
      await coordinator.suspendForPause({
        workflowStepAttemptId: job.workflowStepAttemptId ?? "",
        job,
        transition: { signal: "reply", statePresent: false },
      });
      const pause = await db
        .selectFrom("workflow_pauses")
        .selectAll()
        .executeTakeFirstOrThrow();
      expect(pause).toMatchObject({
        status: "resumed",
        state_present: false,
        state: null,
      });
      const step = await db
        .selectFrom("workflow_step_attempts")
        .where("id", "=", pause.workflow_step_attempt_id)
        .select("output")
        .executeTakeFirstOrThrow();
      expect(step.output).toEqual({ reason: "resumed", value: event.value });
    });

    it("rolls back consumption when creating the continuation fails", async () => {
      const target = await run();
      const early = await coordinator.signalByKey({ ...target, ...event });
      const open = await preparePause(target);
      const enqueue = vi
        .spyOn(jobs, "enqueue")
        .mockRejectedValueOnce(new Error("continuation unavailable"));
      try {
        await expect(open()).rejects.toThrow("continuation unavailable");
      } finally {
        enqueue.mockRestore();
      }
      expect(await replica.signalByKey({ ...target, ...event })).toEqual(early);
      expect(
        await db.selectFrom("workflow_pauses").selectAll().execute(),
      ).toEqual([]);
      expect(await open()).toMatchObject({ status: "resumed" });
    });

    it("claims FIFO and never reuses a signal for the next pause", async () => {
      const target = await run();
      const first = await replica.signalByKey({
        ...target,
        ...event,
        value: 1,
      });
      const second = await coordinator.signalByKey({
        ...target,
        ...event,
        idempotencyKey: "event-2",
        value: 2,
      });
      const open = await preparePause(target);
      expect(await open()).toMatchObject({
        status: "resumed",
        resume_value: 1,
      });
      const next = await preparePause(target);
      expect(await next()).toMatchObject({
        status: "resumed",
        resume_value: 2,
      });
      const rows = await db
        .selectFrom("workflow_signals")
        .selectAll()
        .orderBy("sequence")
        .execute();
      expect(rows.map((row) => row.id)).toEqual([first.id, second.id]);
      expect(rows.every((row) => row.status === "resumed")).toBe(true);
      expect(new Set(rows.map((row) => row.pause_id)).size).toBe(2);
    });

    it("preserves targeted resume and never guesses an unnamed or different pause", async () => {
      const target = await run();
      await coordinator.signalByKey({ ...target, ...event });
      const open = await preparePause(target);
      const pause = await open({});
      expect(pause.status).toBe("open");
      const targeted = {
        identity,
        runId: target.runId,
        pauseId: pause.id,
        idempotencyKey: "targeted",
        value: null,
      };
      await coordinator.resumePause(targeted);
      await coordinator.resumePause(targeted);
      await expect(
        coordinator.resumePause({ ...targeted, value: 1 }),
      ).rejects.toBeInstanceOf(RunResumeConflictError);
      const next = await preparePause(target);
      expect(await next({ signal: "different" })).toMatchObject({
        status: "open",
      });
      expect(
        (await db.selectFrom("workflow_signals").selectAll().execute())[0]
          ?.status,
      ).toBe("buffered");
    });

    it("deduplicates canonical JSON and rejects reuse with a different name or value", async () => {
      const target = await run();
      const receipt = await replica.signalByKey({
        ...target,
        ...event,
        value: { b: [1, null], a: "hello" },
      });
      expect(
        await coordinator.signalByKey({
          ...target,
          ...event,
          value: { a: "hello", b: [1, null] },
        }),
      ).toEqual(receipt);
      await expect(
        coordinator.signalByKey({
          ...target,
          ...event,
          value: { a: "hello", b: [null, 1] },
        }),
      ).rejects.toBeInstanceOf(RunResumeConflictError);
      await expect(
        coordinator.signalByKey({
          ...target,
          ...event,
          signal: "other",
          value: { a: "hello", b: [1, null] },
        }),
      ).rejects.toBeInstanceOf(RunResumeConflictError);
      await expect(
        coordinator.signalByKey({ ...target, ...event, signal: "" }),
      ).rejects.toBeInstanceOf(RunSignalInvalidError);
    });

    it("times out expired pauses before delivery and retains the event for a later pause", async () => {
      const target = await run();
      const early = await coordinator.signalByKey({
        ...target,
        ...event,
        value: null,
      });
      const open = await preparePause(target);
      expect(await open({ signal: "reply", timeout: "0s" })).toMatchObject({
        status: "timed_out",
      });
      expect(
        await replica.signalByKey({ ...target, ...event, value: null }),
      ).toEqual(early);
      const next = await preparePause(target);
      expect(await next()).toMatchObject({
        status: "resumed",
        resume_value: null,
      });
    });

    it("orders a concurrent late callback against the timeout worker", async () => {
      const target = await run();
      const open = await preparePause(target);
      const pause = await open({ signal: "reply", timeout: "1h" });
      await db
        .updateTable("workflow_pauses")
        .set({ timeout_at: new Date(0) })
        .where("id", "=", pause.id)
        .execute();
      await db
        .updateTable("execution_jobs")
        .set({ available_at: new Date(0) })
        .where("kind", "=", "durable_pause_timeout")
        .execute();
      const [job] = await jobs.claim({
        workerId: "timeout",
        kinds: ["durable_pause_timeout"],
        limit: 1,
        leaseSeconds: 60,
      });
      if (!job) throw new Error("Expected timeout job");
      const [, receipt] = await Promise.all([
        coordinator.resolvePauseTimeout({ job }),
        replica.signalByKey({ ...target, ...event }),
      ]);
      expect(receipt.status).toBe("buffered");
      expect(
        await db
          .selectFrom("workflow_pauses")
          .where("id", "=", pause.id)
          .select("status")
          .executeTakeFirst(),
      ).toEqual({ status: "timed_out" });
      expect(
        await db
          .selectFrom("workflow_step_attempts")
          .where("step_index", "=", 1)
          .selectAll()
          .execute(),
      ).toHaveLength(1);
      const next = await preparePause(target);
      expect(await next()).toMatchObject({
        status: "resumed",
        resume_value: event.value,
      });
    });

    it.each(["completed", "failed", "canceling", "canceled"])(
      "clears pending values on %s and rejects new events",
      async (status) => {
        const target = await run();
        const receipt = await coordinator.signalByKey({ ...target, ...event });
        await db
          .updateTable("workflow_runs")
          .set({
            status,
            completed_at: status === "canceling" ? null : new Date(),
          })
          .where("id", "=", target.runId)
          .execute();
        expect(await replica.signalByKey({ ...target, ...event })).toEqual({
          ...receipt,
          status: "discarded",
        });
        expect(
          (await db.selectFrom("workflow_signals").selectAll().execute())[0]
            ?.value,
        ).toBeNull();
        await expect(
          replica.signalByKey({ ...target, ...event, idempotencyKey: "new" }),
        ).rejects.toBeInstanceOf(RunResumeConflictError);
      },
    );

    it("clears an event racing cancellation without leaving an orphan", async () => {
      const target = await run();
      const [delivery] = await Promise.allSettled([
        replica.signalByKey({ ...target, ...event }),
        coordinator.cancel({ identity, runId: target.runId }),
      ]);
      if (delivery.status === "rejected")
        expect(delivery.reason).toBeInstanceOf(RunResumeConflictError);
      const rows = await db
        .selectFrom("workflow_signals")
        .selectAll()
        .execute();
      expect(
        rows.every((row) => row.status === "discarded" && row.value === null),
      ).toBe(true);
      expect(
        await db
          .selectFrom("workflow_runs")
          .where("id", "=", target.runId)
          .select("status")
          .executeTakeFirst(),
      ).toEqual({ status: "canceled" });
    });

    it("fences callbacks by generation, tenant, project, workflow and key", async () => {
      const old = await run();
      await coordinator.signalByKey({ ...old, ...event });
      await coordinator.cancel({ identity, runId: old.runId });
      const replacement = await run();
      await expect(
        replica.signalByKey({
          ...old,
          ...event,
          idempotencyKey: "late-unseen",
        }),
      ).rejects.toBeInstanceOf(RunResumeConflictError);
      for (const mismatch of [
        { runId: crypto.randomUUID() },
        { projectId: crypto.randomUUID() },
        { workflowName: "other" },
        { correlationKey: "other" },
        { identity: { ...identity, tenantId: crypto.randomUUID() } },
      ])
        await expect(
          replica.signalByKey({ ...replacement, ...event, ...mismatch }),
        ).rejects.toBeInstanceOf(RunSignalNotFoundError);
      expect(
        await db
          .selectFrom("workflow_signals")
          .where("run_id", "=", replacement.runId)
          .selectAll()
          .execute(),
      ).toEqual([]);
    });

    it("requires current permission, including duplicate receipts after revocation", async () => {
      const target = await run();
      const granted: Identity = {
        ...identity,
        scope: [],
        projectPermissions: [{ projectId, permission: "runs:write" }],
      };
      const revoked: Identity = { ...granted, projectPermissions: [] };
      await core.runs.signalByKey({ ...target, ...event, identity: granted });
      await expect(
        core.runs.signalByKey({ ...target, ...event, identity: revoked }),
      ).rejects.toBeInstanceOf(AccessDeniedError);
      await expect(
        core.runs.signalByKey({
          ...target,
          ...event,
          identity: { ...granted, tenantId: crypto.randomUUID() },
        }),
      ).rejects.toThrow("not found");
      expect(
        await db.selectFrom("workflow_signals").selectAll().execute(),
      ).toHaveLength(1);
    });

    it("accepts the exact 64 KiB encoded payload limit", async () => {
      const target = await run();
      expect(
        await replica.signalByKey({
          ...target,
          ...event,
          value: "a".repeat(64 * 1024 - 2),
        }),
      ).toMatchObject({ status: "buffered" });
      await expect(
        replica.signalByKey({
          ...target,
          ...event,
          idempotencyKey: "larger",
          value: "a".repeat(64 * 1024 - 1),
        }),
      ).rejects.toBeInstanceOf(RunSignalLimitError);
      expect(
        await db.selectFrom("workflow_signals").selectAll().execute(),
      ).toHaveLength(1);
    });

    it("bounds payload bytes and serializes concurrent sends at pending capacity", async () => {
      const target = await run();
      await expect(
        replica.signalByKey({
          ...target,
          ...event,
          value: "😀".repeat(16_384),
        }),
      ).rejects.toBeInstanceOf(RunSignalLimitError);
      await db
        .insertInto("workflow_signals")
        .values(
          Array.from({ length: RUN_SIGNAL_MAX_PENDING - 1 }, (_, i) => ({
            run_id: target.runId,
            signal_name: "reply",
            idempotency_key: `seed-${i}`,
            payload_hash: "0".repeat(64),
            value: sql`'null'::jsonb`,
          })),
        )
        .execute();
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, (_, i) =>
          replica.signalByKey({
            ...target,
            ...event,
            idempotencyKey: `racing-${i}`,
          }),
        ),
      );
      expect(
        results.filter((entry) => entry.status === "fulfilled"),
      ).toHaveLength(1);
      for (const result of results)
        if (result.status === "rejected")
          expect(result.reason).toBeInstanceOf(RunSignalLimitError);
      expect(
        await db.selectFrom("workflow_signals").selectAll().execute(),
      ).toHaveLength(RUN_SIGNAL_MAX_PENDING);
    });

    it("bounds lifetime receipts, keeps duplicate reads available and cascades on retention", async () => {
      const target = await run();
      const receipt = await coordinator.signalByKey({ ...target, ...event });
      await db
        .insertInto("workflow_signals")
        .values(
          Array.from({ length: RUN_SIGNAL_MAX_RECEIPTS - 1 }, (_, i) => ({
            run_id: target.runId,
            signal_name: "reply",
            idempotency_key: `past-${i}`,
            payload_hash: "0".repeat(64),
            value: null,
            status: "discarded",
            resolved_at: new Date(),
          })),
        )
        .execute();
      await expect(
        replica.signalByKey({
          ...target,
          ...event,
          idempotencyKey: "overflow",
        }),
      ).rejects.toBeInstanceOf(RunSignalLimitError);
      expect(await replica.signalByKey({ ...target, ...event })).toEqual(
        receipt,
      );
      await db
        .deleteFrom("workflow_runs")
        .where("id", "=", target.runId)
        .execute();
      expect(
        await db.selectFrom("workflow_signals").selectAll().execute(),
      ).toEqual([]);
    });
  });
}
