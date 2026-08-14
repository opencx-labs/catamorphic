import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDatabase, migrateToLatest } from "@catamorphic/db";
import { FsBackend, FsRemoteBackend, ProjectManager } from "@catamorphic/git";
import type {
  DeploymentRuntimeProvider,
  RuntimeInvocation,
  RuntimeInvocationReceipt,
  RuntimeTerminalResult,
  SandboxProvider,
} from "@catamorphic/sandbox";
import { RuntimeInfrastructureError } from "@catamorphic/sandbox";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CatamorphicCore } from "../core.js";
import type { Identity } from "../identity.js";
import {
  ExecutionJobsService,
  MAX_LEASE_EXPIRIES,
} from "../services/execution-jobs-service.js";
import { RateReservationsService } from "../services/rate-reservations-service.js";
import { RunCoordinator } from "../services/run-coordinator.js";
import {
  RunEnrollmentConflictError,
  RunSignalNotFoundError,
} from "../services/runs-service.js";

const connectionString = process.env.DATABASE_URL ?? "";
const describeIf = connectionString ? describe : describe.skip;
const schema = `catamorphic_runs_${crypto.randomUUID().replaceAll("-", "")}`;
const db = createDatabase({ connectionString, schema, poolSize: 8 });
const tenantId = crypto.randomUUID();
const projectId = crypto.randomUUID();
const identity: Identity = { tenantId, externalUserId: "run-test-user" };
const commitSha = { value: "" };

let tempDirectory = "";
let projectManager: ProjectManager;
let core: CatamorphicCore;
let secondCore: CatamorphicCore;
let providerOne: FakeSandboxProvider;
let providerTwo: FakeSandboxProvider;
let retryInvocations = 0;
let physicalInvocations = 0;
let physicalBatches: string[][] = [];
let sinkChunks: string[][] = [];
let releaseCanceledBoundary: (() => void) | undefined;
let markCanceledBoundaryStarted: (() => void) | undefined;
let releaseCanceledChild: (() => void) | undefined;
let markCanceledChildStarted: (() => void) | undefined;
let releaseCanceledBatchItems: (() => void) | undefined;
let canceledBatchItemsStarted: Promise<void> | undefined;
let canceledBatchItemsGate: Promise<void> = Promise.resolve();
let markCanceledBatchItemsStarted: (() => void) | undefined;
let canceledBatchItemCount = 0;

describeIf("unified RunsService integration", () => {
  beforeAll(async () => {
    await migrateToLatest({ db, schema });
    tempDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), "catamorphic-unified-runs-"),
    );
    const devDirectory = path.join(tempDirectory, "dev");
    const remoteDirectory = path.join(tempDirectory, "remote");
    await fs.mkdir(devDirectory, { recursive: true });
    await fs.mkdir(remoteDirectory, { recursive: true });
    projectManager = new ProjectManager(
      new FsBackend(devDirectory),
      new FsRemoteBackend(remoteDirectory),
    );
    await db
      .insertInto("tenants")
      .values({ id: tenantId, name: "Runs tenant" })
      .execute();
    await db
      .insertInto("projects")
      .values({
        id: projectId,
        tenant_id: tenantId,
        name: "Unified execution",
      })
      .execute();
    const repo = await projectManager.create(tenantId, projectId, {
      name: "unified-execution",
      externalUserId: identity.externalUserId,
      initialFiles: projectFiles(),
    });
    try {
      commitSha.value = await repo.resolveRef("HEAD");
    } finally {
      await repo.dispose();
    }
    providerOne = new FakeSandboxProvider("first", invokeRuntime);
    providerTwo = new FakeSandboxProvider("second", invokeRuntime);
    core = new CatamorphicCore({
      db,
      projectManager,
      sandboxProvider: providerOne,
    });
    secondCore = new CatamorphicCore({
      db,
      projectManager,
      sandboxProvider: providerTwo,
    });
  });

  afterAll(async () => {
    await Promise.all([core.runs.stopWorkers(), secondCore.runs.stopWorkers()]);
    await sql.raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).execute(db);
    await db.destroy();
    await fs.rm(tempDirectory, { recursive: true, force: true });
  });

  beforeEach(() => {
    retryInvocations = 0;
    physicalInvocations = 0;
    physicalBatches = [];
    sinkChunks = [];
    releaseCanceledBoundary = undefined;
    markCanceledBoundaryStarted = undefined;
    releaseCanceledChild = undefined;
    markCanceledChildStarted = undefined;
    releaseCanceledBatchItems = undefined;
    canceledBatchItemCount = 0;
    canceledBatchItemsStarted = new Promise<void>((resolve) => {
      markCanceledBatchItemsStarted = resolve;
    });
    canceledBatchItemsGate = new Promise<void>((resolve) => {
      releaseCanceledBatchItems = resolve;
    });
    providerOne.invocationCount = 0;
    providerTwo.invocationCount = 0;
    providerOne.canceledInvocationIds.length = 0;
    providerTwo.canceledInvocationIds.length = 0;
    providerOne.resetInvocations();
    providerTwo.resetInvocations();
  });

  it("parses a pinned commit once across repeated invocations", async () => {
    // Every boundary and every batch item resolves the source before invoking.
    // Uncached, a 10k-item batch fetches and parses the project 10k times.
    let opened = 0;
    const openDev = projectManager.openDev.bind(projectManager);
    projectManager.openDev = ((...args: Parameters<typeof openDev>) => {
      opened += 1;
      return openDev(...args);
    }) as typeof openDev;
    try {
      const first = await core.runs.resolveProductionExecution({
        identity,
        projectId,
        workflowName: "approvalWorkflow",
        commitSha: commitSha.value,
      });
      const afterFirst = opened;
      const repeats = await Promise.all(
        Array.from({ length: 8 }, () =>
          core.runs.resolveProductionExecution({
            identity,
            projectId,
            workflowName: "approvalWorkflow",
            commitSha: commitSha.value,
          }),
        ),
      );
      expect(opened).toBe(afterFirst);
      for (const repeat of repeats) expect(repeat).toEqual(first);

      // A different commit is different content and must not be served the
      // cached parse.
      await expect(
        core.runs.resolveProductionExecution({
          identity,
          projectId,
          workflowName: "approvalWorkflow",
          commitSha: "0".repeat(40),
        }),
      ).rejects.toBeDefined();
      expect(opened).toBeGreaterThan(afterFirst);
    } finally {
      projectManager.openDev = openDev;
    }
  });

  it("enrolls, signals, and opts a contact out by correlation key", async () => {
    const worker = core.runs.startWorker({
      name: "campaign",
      kinds: ["durable_boundary", "durable_pause_timeout"],
      pollIntervalMs: 5,
      leaseSeconds: 5,
    });
    const enroll = () =>
      core.runs.triggerProduction({
        identity,
        projectId,
        workflowName: "campaignWorkflow",
        input: { contactId: "contact-1" },
        correlationKey: "contact-1",
      });

    const run = await enroll();
    expect(run.correlationKey).toBe("contact-1");
    await waitForStatus({ runId: run.id, status: "waiting" });

    // A redelivered enrollment webhook must not start a second journey.
    const duplicate = await enroll();
    expect(duplicate.id).toBe(run.id);
    await expect(
      core.runs.triggerProduction({
        identity,
        projectId,
        workflowName: "campaignWorkflow",
        input: { contactId: "contact-1" },
        correlationKey: "contact-1",
        onConflict: "error",
      }),
    ).rejects.toBeInstanceOf(RunEnrollmentConflictError);

    // The caller knows the contact, not the run id.
    const signaled = await core.runs.signalByKey({
      identity,
      projectId,
      workflowName: "campaignWorkflow",
      correlationKey: "contact-1",
      signal: "reply",
      idempotencyKey: "reply-1",
      value: { optedOut: false },
    });
    expect(signaled.id).toBe(run.id);
    await waitForStatus({ runId: run.id, status: "completed" });
    await worker.stop();

    // A finished journey frees the key for re-enrollment.
    const second = await enroll();
    expect(second.id).not.toBe(run.id);

    const optedOut = await core.runs.cancelByKey({
      identity,
      projectId,
      workflowName: "campaignWorkflow",
      correlationKey: "contact-1",
      reason: "unsubscribed",
    });
    expect(optedOut).toMatchObject({ id: second.id, status: "canceled" });

    // Opting out twice is a no-op, not an error.
    await expect(
      core.runs.cancelByKey({
        identity,
        projectId,
        workflowName: "campaignWorkflow",
        correlationKey: "contact-1",
      }),
    ).resolves.toBeNull();

    const history = await core.runs.list({
      identity,
      projectId,
      workflowName: "campaignWorkflow",
      correlationKey: "contact-1",
    });
    expect(history.total).toBe(2);
  });

  it("keeps concurrent enrollments for one key idempotent", async () => {
    const worker = core.runs.startWorker({
      name: "campaign-enroll-race",
      kinds: ["durable_boundary"],
      pollIntervalMs: 5,
      leaseSeconds: 5,
    });
    // Artifact preparation sits between the conflict check and the insert, so
    // simultaneous webhooks both pass the check and race the unique index.
    const enrollments = await Promise.all(
      Array.from({ length: 4 }, () =>
        core.runs.triggerProduction({
          identity,
          projectId,
          workflowName: "campaignWorkflow",
          input: { contactId: "contact-race" },
          correlationKey: "contact-race",
        }),
      ),
    );
    await worker.stop();

    const ids = new Set(enrollments.map((run) => run.id));
    expect(ids.size).toBe(1);
    const history = await core.runs.list({
      identity,
      projectId,
      workflowName: "campaignWorkflow",
      correlationKey: "contact-race",
    });
    expect(history.total).toBe(1);

    await core.runs.cancelByKey({
      identity,
      projectId,
      workflowName: "campaignWorkflow",
      correlationKey: "contact-race",
    });
  }, 20_000);

  it("never leaves a restarted enrollment without a run", async () => {
    const worker = core.runs.startWorker({
      name: "campaign-restart",
      kinds: ["durable_boundary"],
      pollIntervalMs: 5,
      leaseSeconds: 5,
    });
    const first = await core.runs.triggerProduction({
      identity,
      projectId,
      workflowName: "campaignWorkflow",
      input: { contactId: "contact-restart" },
      correlationKey: "contact-restart",
    });
    await waitForStatus({ runId: first.id, status: "waiting" });

    // A failure after the old run is cancelled but before the new one exists
    // would strand the contact mid-journey, so the cancel must come last.
    await expect(
      core.runs.triggerProduction({
        identity,
        projectId,
        workflowName: "missingWorkflow",
        input: { contactId: "contact-restart" },
        correlationKey: "contact-restart",
        onConflict: "restart",
      }),
    ).rejects.toBeDefined();

    const survivor = await core.runs.get({ identity, runId: first.id });
    expect(survivor.status).toBe("waiting");

    const restarted = await core.runs.triggerProduction({
      identity,
      projectId,
      workflowName: "campaignWorkflow",
      input: { contactId: "contact-restart" },
      correlationKey: "contact-restart",
      onConflict: "restart",
    });
    expect(restarted.id).not.toBe(first.id);
    expect((await core.runs.get({ identity, runId: first.id })).status).toBe(
      "canceled",
    );
    await worker.stop();

    await core.runs.cancelByKey({
      identity,
      projectId,
      workflowName: "campaignWorkflow",
      correlationKey: "contact-restart",
    });
  }, 20_000);

  it("restarts an enrollment even when the tenant is over its run cap", async () => {
    const worker = core.runs.startWorker({
      name: "campaign-restart-cap",
      kinds: ["durable_boundary"],
      pollIntervalMs: 5,
      leaseSeconds: 5,
    });
    const first = await core.runs.triggerProduction({
      identity,
      projectId,
      workflowName: "campaignWorkflow",
      input: { contactId: "contact-cap" },
      correlationKey: "contact-cap",
    });
    await waitForStatus({ runId: first.id, status: "waiting" });
    const neighbour = await core.runs.triggerProduction({
      identity,
      projectId,
      workflowName: "campaignWorkflow",
      input: { contactId: "contact-cap-neighbour" },
      correlationKey: "contact-cap-neighbour",
    });
    await waitForStatus({ runId: neighbour.id, status: "waiting" });

    // Lowering the cap under existing load leaves the tenant over budget even
    // after the restart cancels its own run. A restart replaces a run rather
    // than adding one, so it must still succeed — otherwise the contact is
    // cancelled and then refused re-entry, ending up with no journey at all.
    await core.tenantPolicies.upsert({ tenantId, maxActiveRuns: 1 });
    try {
      const restarted = await core.runs.triggerProduction({
        identity,
        projectId,
        workflowName: "campaignWorkflow",
        input: { contactId: "contact-cap" },
        correlationKey: "contact-cap",
        onConflict: "restart",
      });
      expect(restarted.id).not.toBe(first.id);
      const survivor = await core.runs.get({
        identity,
        runId: restarted.id,
      });
      expect(survivor.status).not.toBe("canceled");
    } finally {
      await core.tenantPolicies.delete(tenantId);
      await worker.stop();
      await core.runs.cancelByKey({
        identity,
        projectId,
        workflowName: "campaignWorkflow",
        correlationKey: "contact-cap",
      });
      await core.runs.cancel({ identity, runId: neighbour.id });
    }
  }, 20_000);

  it("rejects an unknown signal instead of guessing a pause", async () => {
    const worker = core.runs.startWorker({
      name: "campaign-unknown-signal",
      kinds: ["durable_boundary"],
      pollIntervalMs: 5,
      leaseSeconds: 5,
    });
    const run = await core.runs.triggerProduction({
      identity,
      projectId,
      workflowName: "campaignWorkflow",
      input: { contactId: "contact-2" },
      correlationKey: "contact-2",
    });
    await waitForStatus({ runId: run.id, status: "waiting" });
    await worker.stop();

    await expect(
      core.runs.signalByKey({
        identity,
        projectId,
        workflowName: "campaignWorkflow",
        correlationKey: "contact-2",
        signal: "bounce",
        idempotencyKey: "bounce-1",
        value: {},
      }),
    ).rejects.toBeInstanceOf(RunSignalNotFoundError);

    await core.runs.cancel({ identity, runId: run.id });
  });

  it("defers a boundary that cannot reserve its shared rate budget", async () => {
    // Drain the whatsapp bucket the campaign's second step draws on. Refill is
    // effectively zero, so the step must park rather than fail.
    const rateReservations = new RateReservationsService(db);
    const limit = {
      key: { globalKey: "campaign-whatsapp" },
      capacity: 2,
      refillRatePerSecond: 0.000_001,
    };
    await rateReservations.reserve({
      tenantId: identity.tenantId,
      limits: [limit],
    });
    await rateReservations.reserve({
      tenantId: identity.tenantId,
      limits: [limit],
    });

    const worker = core.runs.startWorker({
      name: "campaign-rate-limited",
      kinds: ["durable_boundary"],
      pollIntervalMs: 5,
      leaseSeconds: 5,
    });
    const run = await core.runs.triggerProduction({
      identity,
      projectId,
      workflowName: "campaignWorkflow",
      input: { contactId: "contact-3" },
      correlationKey: "contact-3",
    });
    await waitForStatus({ runId: run.id, status: "waiting" });
    await core.runs.signalByKey({
      identity,
      projectId,
      workflowName: "campaignWorkflow",
      correlationKey: "contact-3",
      signal: "reply",
      idempotencyKey: "reply-3",
      value: { optedOut: false },
    });

    const blocked = await waitForRateBlock({
      runId: run.id,
      stepIndex: 1,
      timeout: 10_000,
    });
    await worker.stop();

    expect(blocked?.rate_blocked_until).toBeInstanceOf(Date);
    // Waiting for capacity must not burn the boundary's retry budget.
    expect(blocked?.attempt).toBe(1);
    const current = await core.runs.get({ identity, runId: run.id });
    expect(current.status).not.toBe("failed");
    await core.runs.cancel({ identity, runId: run.id });
  }, 20_000);

  it("resumes a boundary pause idempotently across worker restarts", async () => {
    const first = core.runs.startWorker({
      name: "pause-first",
      kinds: ["durable_boundary", "durable_pause_timeout"],
      pollIntervalMs: 5,
      leaseSeconds: 5,
    });
    const run = await core.runs.triggerProduction({
      identity,
      projectId,
      workflowName: "approvalWorkflow",
      input: { orderId: "order-1" },
    });
    await waitForStatus({ runId: run.id, status: "waiting" });
    await first.stop();
    const waiting = await core.runs.get({ identity, runId: run.id });
    expect(waiting).toMatchObject({
      phase: "pause",
      currentStepIndex: 0,
      activePause: { state: { requestId: "request-1" } },
      capabilities: {
        cancel: true,
        pauseProcessing: false,
        resumeProcessing: false,
        submitInput: true,
        inspectItems: false,
      },
    });
    if (!waiting.activePause) throw new Error("Expected active pause");

    const second = secondCore.runs.startWorker({
      name: "pause-second",
      kinds: ["durable_boundary", "durable_pause_timeout"],
      pollIntervalMs: 5,
      leaseSeconds: 5,
    });
    const boundaryJob = await db
      .selectFrom("execution_jobs")
      .where("workflow_run_id", "=", run.id)
      .where("kind", "=", "durable_boundary")
      .select("id")
      .executeTakeFirstOrThrow();
    await db
      .updateTable("execution_jobs")
      .set({
        status: "pending",
        available_at: new Date(),
        completed_at: null,
      })
      .where("id", "=", boundaryJob.id)
      .execute();
    await waitForJobStatus({ jobId: boundaryJob.id, status: "completed" });
    expect(providerTwo.invocationCount).toBe(0);
    expect(
      await db
        .selectFrom("workflow_pauses")
        .where("run_id", "=", run.id)
        .select((eb) => eb.fn.countAll<number>().as("count"))
        .executeTakeFirstOrThrow(),
    ).toEqual({ count: "1" });
    const resume = {
      identity,
      runId: run.id,
      pauseId: waiting.activePause.id,
      idempotencyKey: "resume-1",
      value: { approved: true },
    };
    await Promise.all([
      core.runs.resumePause(resume),
      core.runs.resumePause(resume),
    ]);
    await waitForStatus({ runId: run.id, status: "completed" });
    await second.stop();
    const completed = await core.runs.get({ identity, runId: run.id });
    expect(completed.result).toEqual({ approved: true });
    expect(completed.capabilities).toEqual({
      cancel: false,
      pauseProcessing: false,
      resumeProcessing: false,
      submitInput: false,
      inspectItems: false,
    });
    expect(completed.workflowStepAttempts).toHaveLength(2);
    await expect(core.runs.resumePause(resume)).resolves.toMatchObject({
      id: run.id,
      status: "completed",
    });
  });

  it("resolves an overdue explicit resume through the timeout path", async () => {
    const worker = core.runs.startWorker({
      name: "pause-timeout",
      kinds: ["durable_boundary"],
      pollIntervalMs: 5,
      leaseSeconds: 5,
    });
    const run = await core.runs.triggerProduction({
      identity,
      projectId,
      workflowName: "timeoutWorkflow",
      input: { orderId: "order-timeout" },
    });
    await waitForStatus({ runId: run.id, status: "waiting" });
    const waiting = await core.runs.get({ identity, runId: run.id });
    if (!waiting.activePause) throw new Error("Expected active pause");
    await new Promise((resolve) => setTimeout(resolve, 10));
    await core.runs.resumePause({
      identity,
      runId: run.id,
      pauseId: waiting.activePause.id,
      idempotencyKey: "late-resume",
      value: { approved: true },
    });
    await waitForStatus({ runId: run.id, status: "completed" });
    await worker.stop();
    const pause = await db
      .selectFrom("workflow_pauses")
      .where("id", "=", waiting.activePause.id)
      .select("status")
      .executeTakeFirstOrThrow();
    expect(pause.status).toBe("timed_out");
    expect((await core.runs.get({ identity, runId: run.id })).result).toEqual({
      reason: "timed_out",
      state: { requestId: "request-timeout" },
    });
  });

  it("creates semantic retries and recursively continues a parent child call", async () => {
    const worker = core.runs.startWorker({
      name: "retry-child",
      kinds: ["durable_boundary"],
      concurrency: 2,
      pollIntervalMs: 5,
      leaseSeconds: 5,
    });
    const retry = await core.runs.triggerProduction({
      identity,
      projectId,
      workflowName: "retryWorkflow",
      input: { retry: true },
    });
    const parent = await core.runs.triggerProduction({
      identity,
      projectId,
      workflowName: "parentWorkflow",
      input: { parent: true },
    });
    await Promise.all([
      waitForStatus({ runId: retry.id, status: "completed" }),
      waitForStatus({ runId: parent.id, status: "completed" }),
    ]);
    await worker.stop();
    const retryDetail = await core.runs.get({ identity, runId: retry.id });
    expect(
      retryDetail.workflowStepAttempts.map(({ attempt, status }) => ({
        attempt,
        status,
      })),
    ).toEqual([
      { attempt: 1, status: "failed" },
      { attempt: 2, status: "completed" },
    ]);
    const child = await db
      .selectFrom("workflow_runs")
      .where("parent_run_id", "=", parent.id)
      .select(["id", "parent_workflow_step_attempt_id", "status"])
      .executeTakeFirstOrThrow();
    expect(child).toMatchObject({
      status: "completed",
      parent_workflow_step_attempt_id: expect.any(String),
    });
    expect(
      (await core.runs.get({ identity, runId: parent.id })).result,
    ).toEqual({
      child: "completed",
    });
  });

  it("retries transport failures without consuming boundary semantics", async () => {
    providerOne.failAfterExecutionOnce(
      "durable-boundary:transportBoundaryWorkflow",
    );
    const worker = core.runs.startWorker({
      name: "transport-retries",
      kinds: ["durable_boundary"],
      concurrency: 2,
      pollIntervalMs: 5,
      leaseSeconds: 5,
    });
    const boundary = await core.runs.triggerProduction({
      identity,
      projectId,
      workflowName: "transportBoundaryWorkflow",
      input: { transport: true },
    });
    await waitForStatus({ runId: boundary.id, status: "completed" });
    await worker.stop();

    const boundaryIds = providerOne.invocationIds.filter((id) =>
      id.startsWith(`${boundary.id}:`),
    );
    expect(boundaryIds).toEqual([
      `${boundary.id}:step:0:attempt:1`,
      `${boundary.id}:step:0:attempt:1`,
    ]);
    expect(
      providerOne.executionIds.filter((id) => id === boundaryIds[0]),
    ).toHaveLength(1);
    expect(
      (await core.runs.get({ identity, runId: boundary.id }))
        .workflowStepAttempts,
    ).toEqual([expect.objectContaining({ attempt: 1, status: "completed" })]);
  }, 15_000);

  it("does not turn exhausted boundary delivery into a semantic retry", async () => {
    providerOne.failAlways("durable-boundary:transportBoundaryWorkflow");
    const run = await core.runs.triggerProduction({
      identity,
      projectId,
      workflowName: "transportBoundaryWorkflow",
      input: { transport: true },
    });
    await db
      .updateTable("execution_jobs")
      .set({ max_attempts: 1 })
      .where("workflow_run_id", "=", run.id)
      .where("kind", "=", "durable_boundary")
      .execute();
    const worker = core.runs.startWorker({
      name: "boundary-transport-exhaustion",
      kinds: ["durable_boundary"],
      pollIntervalMs: 5,
      leaseSeconds: 5,
    });
    await waitForStatus({ runId: run.id, status: "failed" });
    await worker.stop();

    const detail = await core.runs.get({ identity, runId: run.id });
    expect(detail.workflowStepAttempts).toEqual([
      expect.objectContaining({ attempt: 1, status: "failed" }),
    ]);
  });

  it("retries batch transport failures with new execution identities", async () => {
    for (const key of [
      "batch-source:initialize",
      "batch-source:readPage",
      "batch-step:process",
      "batch-step:run",
      "batch-sink:writeBatch",
    ]) {
      providerOne.failAfterExecutionOnce(key);
    }
    const worker = core.runs.startWorker({
      name: "batch-transport-retries",
      concurrency: 4,
      pollIntervalMs: 5,
      leaseSeconds: 5,
    });
    const run = await core.runs.triggerProduction({
      identity,
      projectId,
      workflowName: "batchWorkflow",
      input: { batch: true },
    });
    await waitForStatus({
      runId: run.id,
      status: "completed",
      timeout: 25_000,
    });
    await worker.stop();

    for (const key of [
      "batch-source:initialize",
      "batch-source:readPage",
      "batch-step:process",
      "batch-step:run",
      "batch-sink:writeBatch",
    ]) {
      const ids = providerOne.invocationsByOperation.get(key) ?? [];
      expect(ids.length).toBeGreaterThanOrEqual(2);
      expect(new Set(ids).size).toBe(ids.length);
    }
    expect((await core.runs.get({ identity, runId: run.id })).result).toEqual({
      summary: { total: 2, succeeded: 2, failed: 0, skipped: 0 },
      artifact: { fileName: "results.json", itemCount: 2 },
    });
  }, 30_000);

  it("acknowledges waiting child-boundary redelivery without another child", async () => {
    const first = core.runs.startWorker({
      name: "child-redelivery-first",
      kinds: ["durable_boundary"],
      pollIntervalMs: 5,
      leaseSeconds: 5,
    });
    const parent = await core.runs.triggerProduction({
      identity,
      projectId,
      workflowName: "parentWaitingChildWorkflow",
      input: { parent: true },
    });
    await waitForStatus({ runId: parent.id, status: "waiting" });
    // Let the child's own boundary reach its pause before stopping the worker,
    // so the second worker has nothing to claim but the redelivered parent job.
    const waitingChild = await waitForChildRun({ parentRunId: parent.id });
    await waitForStatus({ runId: waitingChild.id, status: "waiting" });
    await first.stop();
    const parentJob = await db
      .selectFrom("execution_jobs")
      .where("workflow_run_id", "=", parent.id)
      .where("kind", "=", "durable_boundary")
      .select("id")
      .executeTakeFirstOrThrow();
    await db
      .updateTable("execution_jobs")
      .set({ status: "pending", available_at: new Date(), completed_at: null })
      .where("id", "=", parentJob.id)
      .execute();
    const second = secondCore.runs.startWorker({
      name: "child-redelivery-second",
      kinds: ["durable_boundary"],
      pollIntervalMs: 5,
      leaseSeconds: 5,
    });
    await waitForJobStatus({ jobId: parentJob.id, status: "completed" });
    await second.stop();
    expect(providerTwo.invocationCount).toBe(0);
    expect(
      await db
        .selectFrom("workflow_runs")
        .where("parent_run_id", "=", parent.id)
        .select((eb) => eb.fn.countAll<number>().as("count"))
        .executeTakeFirstOrThrow(),
    ).toEqual({ count: "1" });
    await core.runs.cancel({
      identity,
      runId: parent.id,
      reason: "test cleanup",
    });
  });

  it("rejects stale leases and durably fails an exhausted expired job", async () => {
    const run = await core.runs.triggerProduction({
      identity,
      projectId,
      workflowName: "transportBoundaryWorkflow",
      input: { transport: true },
    });
    const jobs = new ExecutionJobsService(db);
    const [claimed] = await jobs.claim({
      workerId: "stale-lease-test",
      kinds: ["durable_boundary"],
      limit: 1,
      leaseSeconds: 60,
    });
    if (!claimed || claimed.workflowRunId !== run.id) {
      throw new Error("Expected to claim the boundary job");
    }
    const staleGeneration = String(Number(claimed.leaseGeneration) - 1);
    const leaseToken = claimed.leaseToken;
    if (!leaseToken) throw new Error("Expected a lease token");
    await expect(
      jobs.complete({
        jobId: claimed.id,
        workerId: "stale-lease-test",
        leaseToken,
        leaseGeneration: staleGeneration,
      }),
    ).resolves.toBe(false);
    await expect(
      jobs.fail({
        jobId: claimed.id,
        workerId: "stale-lease-test",
        leaseToken,
        leaseGeneration: staleGeneration,
        error: "stale",
      }),
    ).resolves.toBeNull();
    await expect(
      jobs.release({
        jobId: claimed.id,
        workerId: "stale-lease-test",
        leaseToken,
        leaseGeneration: staleGeneration,
        availableAt: new Date(),
      }),
    ).resolves.toBe(false);
    await db
      .updateTable("execution_jobs")
      .set({
        attempt: claimed.maxAttempts,
        // Expiries are attempt-neutral; only the expiry cap makes an
        // expired lease terminal, so park this job one expiry short of it.
        lease_expiries: MAX_LEASE_EXPIRIES - 1,
        lease_expires_at: new Date(Date.now() - 1_000),
      })
      .where("id", "=", claimed.id)
      .execute();
    await expect(
      jobs.complete({
        jobId: claimed.id,
        workerId: "stale-lease-test",
        leaseToken,
        leaseGeneration: claimed.leaseGeneration,
      }),
    ).resolves.toBe(false);
    await expect(
      jobs.fail({
        jobId: claimed.id,
        workerId: "stale-lease-test",
        leaseToken,
        leaseGeneration: claimed.leaseGeneration,
        error: "expired",
      }),
    ).resolves.toBeNull();
    await expect(
      jobs.release({
        jobId: claimed.id,
        workerId: "stale-lease-test",
        leaseToken,
        leaseGeneration: claimed.leaseGeneration,
        availableAt: new Date(),
      }),
    ).resolves.toBe(false);

    const worker = core.runs.startWorker({
      name: "expired-exhaustion",
      kinds: ["durable_boundary"],
      pollIntervalMs: 5,
      leaseSeconds: 5,
    });
    await waitForStatus({ runId: run.id, status: "failed" });
    await worker.stop();
    expect(
      await db
        .selectFrom("execution_jobs")
        .where("id", "=", claimed.id)
        .select(["status", "attempt", "exhaustion_handled_at"])
        .executeTakeFirstOrThrow(),
    ).toEqual({
      status: "failed",
      attempt: claimed.maxAttempts,
      exhaustion_handled_at: expect.any(Date),
    });
  });

  it("cleans pause and queued work when an attempt job is exhausted", async () => {
    const first = core.runs.startWorker({
      name: "pause-exhaustion-first",
      kinds: ["durable_boundary"],
      pollIntervalMs: 5,
      leaseSeconds: 5,
    });
    const run = await core.runs.triggerProduction({
      identity,
      projectId,
      workflowName: "timeoutWorkflow",
      input: { orderId: "exhaustion" },
    });
    await waitForStatus({ runId: run.id, status: "waiting" });
    await first.stop();
    const timeoutJob = await db
      .selectFrom("execution_jobs")
      .where("workflow_run_id", "=", run.id)
      .where("kind", "=", "durable_pause_timeout")
      .select(["id", "workflow_step_attempt_id"])
      .executeTakeFirstOrThrow();
    const boundaryJob = await db
      .selectFrom("execution_jobs")
      .where("workflow_run_id", "=", run.id)
      .where("kind", "=", "durable_boundary")
      .select("id")
      .executeTakeFirstOrThrow();
    await db
      .updateTable("execution_jobs")
      .set({ status: "pending", completed_at: null, available_at: new Date() })
      .where("id", "=", boundaryJob.id)
      .execute();
    await db
      .updateTable("execution_jobs")
      .set({
        status: "running",
        attempt: 1,
        max_attempts: 1,
        // One expiry short of the cap: the sweep's next requeue pass must
        // durably fail this job rather than refund-and-requeue it.
        lease_expiries: MAX_LEASE_EXPIRIES - 1,
        leased_by: "crashed-worker",
        lease_token: crypto.randomUUID(),
        lease_generation: "1",
        heartbeat_at: new Date(Date.now() - 2_000),
        lease_expires_at: new Date(Date.now() - 1_000),
      })
      .where("id", "=", timeoutJob.id)
      .execute();
    await db
      .insertInto("active_run_invocations")
      .values({
        invocation_id: "stale-invocation",
        workflow_run_id: run.id,
        workflow_step_attempt_id: timeoutJob.workflow_step_attempt_id,
        execution_job_id: timeoutJob.id,
        lease_token: await db
          .selectFrom("execution_jobs")
          .where("id", "=", timeoutJob.id)
          .select("lease_token")
          .executeTakeFirstOrThrow()
          .then((job) => job.lease_token ?? ""),
        lease_generation: "1",
      })
      .execute();
    const second = secondCore.runs.startWorker({
      name: "pause-exhaustion-second",
      kinds: ["durable_pause_timeout"],
      pollIntervalMs: 5,
      leaseSeconds: 5,
    });
    await waitForStatus({ runId: run.id, status: "failed" });
    await second.stop();
    expect(
      await db
        .selectFrom("active_run_invocations")
        .where("workflow_run_id", "=", run.id)
        .select((eb) => eb.fn.countAll<number>().as("count"))
        .executeTakeFirstOrThrow(),
    ).toEqual({ count: "0" });
    expect(
      await db
        .selectFrom("workflow_pauses")
        .where("run_id", "=", run.id)
        .select("status")
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: "canceled" });
    expect(
      await db
        .selectFrom("execution_jobs")
        .where("id", "=", boundaryJob.id)
        .select("status")
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: "canceled" });
    expect(
      await db
        .selectFrom("workflow_step_attempts")
        .where("id", "=", timeoutJob.workflow_step_attempt_id ?? "")
        .select("status")
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: "failed" });
  });

  it("propagates child success and failure to parent boundaries", async () => {
    const worker = core.runs.startWorker({
      name: "child-outcomes",
      kinds: ["durable_boundary"],
      concurrency: 3,
      pollIntervalMs: 5,
      leaseSeconds: 5,
    });
    const successful = await core.runs.triggerProduction({
      identity,
      projectId,
      workflowName: "parentCompletingChildWorkflow",
      input: { parent: true },
    });
    const failing = await core.runs.triggerProduction({
      identity,
      projectId,
      workflowName: "parentFailingChildWorkflow",
      input: { parent: true },
    });
    await Promise.all([
      waitForStatus({ runId: successful.id, status: "completed" }),
      waitForStatus({ runId: failing.id, status: "failed" }),
    ]);
    await worker.stop();

    expect(
      (await core.runs.get({ identity, runId: successful.id })).result,
    ).toEqual({ child: "child-completed" });
    const children = await db
      .selectFrom("workflow_runs")
      .where("parent_run_id", "in", [successful.id, failing.id])
      .select(["parent_run_id", "status"])
      .orderBy("parent_run_id")
      .execute();
    expect(children.map((child) => child.status).sort()).toEqual([
      "completed",
      "failed",
    ]);
  });

  it("recursively cancels and fences a running child", async () => {
    let startedResolve = (): void => {};
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    markCanceledChildStarted = startedResolve;
    const worker = core.runs.startWorker({
      name: "cancel-child",
      kinds: ["durable_boundary"],
      concurrency: 2,
      pollIntervalMs: 5,
      leaseSeconds: 5,
    });
    const run = await core.runs.triggerProduction({
      identity,
      projectId,
      workflowName: "parentCancelableChildWorkflow",
      input: { parent: true },
    });
    await started;
    await core.runs.cancel({
      identity,
      runId: run.id,
      reason: "cancel child hierarchy",
    });
    releaseCanceledChild?.();
    await new Promise((resolve) => setTimeout(resolve, 25));
    await worker.stop();
    const hierarchy = await db
      .selectFrom("workflow_runs")
      .where((eb) =>
        eb.or([eb("id", "=", run.id), eb("parent_run_id", "=", run.id)]),
      )
      .select(["status", "result"])
      .execute();
    expect(hierarchy).toHaveLength(2);
    expect(hierarchy.every((entry) => entry.status === "canceled")).toBe(true);
    expect(hierarchy.every((entry) => entry.result === null)).toBe(true);
    expect(providerOne.canceledInvocationIds).toHaveLength(1);
  });

  it("fails a waiting parent when its child is canceled directly", async () => {
    const parent = await core.runs.triggerProduction({
      identity,
      projectId,
      workflowName: "parentWorkflow",
      input: { parent: true },
    });
    const worker = core.runs.startWorker({
      name: "cancel-direct-child",
      kinds: ["durable_boundary"],
      pollIntervalMs: 5,
      leaseSeconds: 5,
    });
    // Wait for the child row, not for the parent's `waiting` status. The parent
    // holds `waiting` only between spawning the child and that child finishing,
    // and childWorkflow returns immediately, so polling for the status can miss
    // the window entirely. The child row is durable once created.
    const child = await waitForChildRun({ parentRunId: parent.id });
    await worker.stop();

    await core.runs.cancel({
      identity,
      runId: child.id,
      reason: "child canceled directly",
    });

    await waitForStatus({ runId: parent.id, status: "failed" });
    expect(await core.runs.get({ identity, runId: child.id })).toMatchObject({
      status: "canceled",
      result: null,
    });
    expect(await core.runs.get({ identity, runId: parent.id })).toMatchObject({
      status: "failed",
      error: "child canceled directly",
      workflowStepAttempts: [
        expect.objectContaining({
          status: "failed",
          error: "child canceled directly",
        }),
      ],
    });
  });

  it("locks the root before discovering descendants during child creation", async () => {
    const jobs = new ExecutionJobsService(db);
    const coordinator = new RunCoordinator(db, jobs);
    const parent = await core.runs.triggerProduction({
      identity,
      projectId,
      workflowName: "parentWorkflow",
      input: { parent: true },
    });
    const [job] = await jobs.claim({
      workerId: "cancel-child-race",
      kinds: ["durable_boundary"],
      limit: 1,
      leaseSeconds: 60,
    });
    if (!job || job.workflowRunId !== parent.id) {
      throw new Error("Expected to claim the parent boundary job");
    }
    expect(await coordinator.beginAttempt({ job, phase: "boundary" })).toBe(
      true,
    );
    const child = await core.runs.resolveProductionWorkflow({
      identity,
      projectId,
      workflowName: "childWorkflow",
      commitSha: commitSha.value,
    });

    let releaseRootLock = (): void => {};
    let markRootLocked = (): void => {};
    let rootLockPid = 0;
    const rootLocked = new Promise<void>((resolve) => {
      markRootLocked = resolve;
    });
    const rootLockRelease = new Promise<void>((resolve) => {
      releaseRootLock = resolve;
    });
    const holdRootLock = db.transaction().execute(async (trx) => {
      await trx
        .selectFrom("workflow_runs")
        .where("id", "=", parent.id)
        .select("id")
        .forUpdate()
        .executeTakeFirstOrThrow();
      const backend = await sql<{ pid: number }>`
        SELECT pg_backend_pid() AS pid
      `.execute(trx);
      rootLockPid = backend.rows[0]?.pid ?? 0;
      markRootLocked();
      await rootLockRelease;
    });
    await rootLocked;

    let childRunId: string | null = null;
    try {
      const cancellation = core.runs.cancel({
        identity,
        runId: parent.id,
        reason: "raced child creation",
      });
      await waitForBlockedOnPid({ pid: rootLockPid });
      const childCreation = coordinator.suspendForChild({
        workflowStepAttemptId: job.workflowStepAttemptId ?? "",
        job,
        child: {
          workflowName: "childWorkflow",
          capabilities: child.capabilities,
          execution: child.execution,
          input: { child: true },
        },
      });
      await waitForBlockedOnPid({ pid: rootLockPid, count: 2 });
      releaseRootLock();
      [, childRunId] = await Promise.all([cancellation, childCreation]);
      await holdRootLock;
    } finally {
      releaseRootLock();
      await holdRootLock;
    }
    expect(childRunId).toBeNull();
    expect(
      await db
        .selectFrom("workflow_runs")
        .where("parent_run_id", "=", parent.id)
        .select((eb) => eb.fn.countAll<number>().as("count"))
        .executeTakeFirstOrThrow(),
    ).toEqual({ count: "0" });
    expect(await core.runs.get({ identity, runId: parent.id })).toMatchObject({
      status: "canceled",
    });
  }, 10_000);

  it("fences a late boundary receipt after recursive cancellation", async () => {
    let startedResolve = (): void => {};
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    markCanceledBoundaryStarted = startedResolve;
    const worker = core.runs.startWorker({
      name: "cancel-late",
      kinds: ["durable_boundary"],
      pollIntervalMs: 5,
      leaseSeconds: 5,
    });
    const run = await core.runs.triggerProduction({
      identity,
      projectId,
      workflowName: "cancelWorkflow",
      input: { cancel: true },
    });
    await started;
    await core.runs.cancel({ identity, runId: run.id, reason: "test" });
    releaseCanceledBoundary?.();
    await new Promise((resolve) => setTimeout(resolve, 25));
    await worker.stop();
    const canceled = await core.runs.get({ identity, runId: run.id });
    expect(canceled).toMatchObject({ status: "canceled", result: null });
    expect(canceled.workflowStepAttempts).toEqual([
      expect.objectContaining({ status: "canceled" }),
    ]);
    expect(providerOne.canceledInvocationIds).toHaveLength(1);
  });

  it("cancels every concurrent batch item invocation and fences receipts", async () => {
    const worker = core.runs.startWorker({
      name: "cancel-concurrent-batch",
      kinds: ["batch_source", "batch_item"],
      concurrency: 4,
      pollIntervalMs: 5,
      leaseSeconds: 5,
    });
    const run = await core.runs.triggerProduction({
      identity,
      projectId,
      workflowName: "cancelBatchWorkflow",
      input: { cancel: true },
    });
    await Promise.race([
      canceledBatchItemsStarted,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("Batch item invocations did not start")),
          5_000,
        ),
      ),
    ]);
    const active = await db
      .selectFrom("active_run_invocations")
      .innerJoin(
        "execution_jobs",
        "execution_jobs.id",
        "active_run_invocations.execution_job_id",
      )
      .where("active_run_invocations.workflow_run_id", "=", run.id)
      .where("execution_jobs.kind", "=", "batch_item")
      .select("active_run_invocations.invocation_id")
      .orderBy("active_run_invocations.invocation_id")
      .execute();
    expect(active).toHaveLength(3);

    await core.runs.cancel({
      identity,
      runId: run.id,
      reason: "cancel concurrent batch",
    });
    releaseCanceledBatchItems?.();
    await new Promise((resolve) => setTimeout(resolve, 25));
    await worker.stop();

    expect(providerOne.canceledInvocationIds.sort()).toEqual(
      active.map((invocation) => invocation.invocation_id).sort(),
    );
    expect(await core.runs.get({ identity, runId: run.id })).toMatchObject({
      status: "canceled",
      result: null,
    });
    expect(
      await db
        .selectFrom("active_run_invocations")
        .where("workflow_run_id", "=", run.id)
        .select((eb) => eb.fn.countAll<number>().as("count"))
        .executeTakeFirstOrThrow(),
    ).toEqual({ count: "0" });
  });

  it("coalesces physical batches, retries one member, and finalizes the sink", async () => {
    const worker = core.runs.startWorker({
      name: "physical-batch",
      concurrency: 4,
      pollIntervalMs: 5,
      leaseSeconds: 5,
    });
    const run = await core.runs.triggerProduction({
      identity,
      projectId,
      workflowName: "batchWorkflow",
      input: { batch: true },
    });
    await waitForStatus({
      runId: run.id,
      status: "completed",
      timeout: 15_000,
    });
    await worker.stop();
    const completed = await core.runs.get({ identity, runId: run.id });
    expect(completed.result).toEqual({
      summary: { total: 2, succeeded: 2, failed: 0, skipped: 0 },
      artifact: { fileName: "results.json", itemCount: 2 },
    });
    expect(completed.batchScopes).toEqual([
      expect.objectContaining({
        stepIndex: 0,
        nodeId: expect.any(String),
        attempt: 1,
        status: "completed",
        discovered: 2,
        succeeded: 2,
        failed: 0,
        sinkCompletedChunks: 1,
      }),
    ]);
    expect(completed.capabilities).toEqual({
      cancel: false,
      pauseProcessing: false,
      resumeProcessing: false,
      submitInput: false,
      inspectItems: true,
    });
    const batchState = await db
      .selectFrom("batch_execution_states")
      .where("run_id", "=", run.id)
      .select("failure_policy")
      .executeTakeFirstOrThrow();
    expect(batchState.failure_policy).toEqual({
      mode: "fail_fast",
      maxFailures: 2,
    });
    expect(physicalBatches).toEqual([["item-1", "item-2"], ["item-2"]]);
    expect(sinkChunks).toEqual([["item-1", "item-2"]]);
  }, 20_000);

  it("deduplicates source keys into contiguous order and preserves JSON null", async () => {
    const worker = core.runs.startWorker({
      name: "null-source-values",
      concurrency: 3,
      pollIntervalMs: 5,
      leaseSeconds: 5,
    });
    const run = await core.runs.triggerProduction({
      identity,
      projectId,
      workflowName: "nullBatchWorkflow",
      input: null,
    });
    await waitForStatus({
      runId: run.id,
      status: "completed",
      timeout: 15_000,
    });
    await worker.stop();

    const [state, items] = await Promise.all([
      db
        .selectFrom("batch_execution_states")
        .where("run_id", "=", run.id)
        .select([
          "source_snapshot",
          "source_snapshot_present",
          "source_cursor",
          "source_cursor_present",
          "sink_state",
          "sink_state_present",
          "discovered_count",
        ])
        .executeTakeFirstOrThrow(),
      db
        .selectFrom("batch_items")
        .where("run_id", "=", run.id)
        .select(["item_key", "source_order", "value", "output"])
        .orderBy("source_order")
        .execute(),
    ]);
    expect(state).toMatchObject({
      source_snapshot: null,
      source_snapshot_present: true,
      source_cursor: null,
      source_cursor_present: true,
      sink_state: null,
      sink_state_present: true,
      discovered_count: "3",
    });
    expect(
      items.map((item) => ({
        key: item.item_key,
        order: Number(item.source_order),
        value: item.value,
        output: item.output,
      })),
    ).toEqual([
      { key: "null-1", order: 0, value: null, output: null },
      { key: "null-2", order: 1, value: null, output: null },
      { key: "null-3", order: 2, value: null, output: null },
    ]);
  }, 20_000);

  it("persists the exact repeated-call occurrence and skipped physical outcome", async () => {
    const worker = core.runs.startWorker({
      name: "physical-occurrence",
      concurrency: 4,
      pollIntervalMs: 5,
      leaseSeconds: 5,
    });
    const run = await core.runs.triggerProduction({
      identity,
      projectId,
      workflowName: "occurrenceBatchWorkflow",
      input: { occurrence: true },
    });
    await waitForStatus({
      runId: run.id,
      status: "completed",
      timeout: 15_000,
    });
    await worker.stop();

    const [members, steps] = await Promise.all([
      db
        .selectFrom("batch_step_members")
        .where("run_id", "=", run.id)
        .select(["member_key", "occurrence", "status", "output_present"])
        .orderBy("member_key")
        .execute(),
      db
        .selectFrom("batch_item_steps")
        .where("run_id", "=", run.id)
        .where("occurrence", "=", 1)
        .select(["occurrence", "status", "output", "output_present"])
        .orderBy("status")
        .execute(),
    ]);
    expect(members).toEqual([
      {
        member_key: "occurrence-1",
        occurrence: 1,
        status: "succeeded",
        output_present: true,
      },
      {
        member_key: "occurrence-2",
        occurrence: 1,
        status: "skipped",
        output_present: false,
      },
    ]);
    expect(steps).toEqual([
      {
        occurrence: 1,
        status: "completed",
        output: null,
        output_present: true,
      },
      {
        occurrence: 1,
        status: "skipped",
        output: null,
        output_present: false,
      },
    ]);
  }, 20_000);

  it("timestamps a physical invocation after its final failed attempt", async () => {
    const setup = core.runs.startWorker({
      name: "physical-failure-setup",
      kinds: ["batch_source", "batch_item"],
      concurrency: 2,
      pollIntervalMs: 5,
      leaseSeconds: 5,
    });
    const run = await core.runs.triggerProduction({
      identity,
      projectId,
      workflowName: "physicalFailureWorkflow",
      input: { fail: true },
    });
    await waitForJob({ runId: run.id, kind: "batch_step" });
    await setup.stop();
    await db
      .updateTable("execution_jobs")
      .set({ max_attempts: 1 })
      .where("workflow_run_id", "=", run.id)
      .where("kind", "=", "batch_step")
      .execute();
    const failure = core.runs.startWorker({
      name: "physical-failure-final",
      kinds: ["batch_step"],
      pollIntervalMs: 5,
      leaseSeconds: 5,
    });
    await waitForStatus({ runId: run.id, status: "failed", timeout: 15_000 });
    await failure.stop();

    const invocation = await db
      .selectFrom("batch_step_invocations")
      .where("run_id", "=", run.id)
      .select(["status", "completed_at", "error"])
      .executeTakeFirstOrThrow();
    expect(invocation).toMatchObject({
      status: "failed",
      completed_at: expect.any(Date),
      error: "physical invocation failed",
    });
  }, 20_000);

  it("pauses and resumes operators while advancing boundary to batch to boundary", async () => {
    const run = await core.runs.triggerProduction({
      identity,
      projectId,
      workflowName: "mixedWorkflow",
      input: { mixed: true },
    });
    await expect(core.runs.pause({ identity, runId: run.id })).rejects.toEqual(
      expect.objectContaining({
        name: "RunCapabilityError",
        capability: "pauseProcessing",
      }),
    );
    await expect(core.runs.resume({ identity, runId: run.id })).rejects.toEqual(
      expect.objectContaining({
        name: "RunCapabilityError",
        capability: "resumeProcessing",
      }),
    );
    expect(
      (await core.runs.get({ identity, runId: run.id })).capabilities,
    ).toEqual({
      cancel: true,
      pauseProcessing: false,
      resumeProcessing: false,
      submitInput: false,
      inspectItems: false,
    });
    const worker = core.runs.startWorker({
      name: "mixed",
      concurrency: 3,
      pollIntervalMs: 5,
      leaseSeconds: 5,
    });
    await waitForStatus({
      runId: run.id,
      status: "completed",
      timeout: 15_000,
    });
    await worker.stop();
    const completed = await core.runs.get({ identity, runId: run.id });
    expect(completed.result).toEqual({ mixed: "completed" });
    expect(
      completed.workflowStepAttempts.map((attempt) => attempt.executor),
    ).toEqual(["boundary", "batch", "boundary"]);
  }, 20_000);

  it("keeps multiple batch scopes independent in one run", async () => {
    const run = await core.runs.triggerProduction({
      identity,
      projectId,
      workflowName: "multipleBatchWorkflow",
      input: { batches: true },
    });
    expect(
      (await core.runs.get({ identity, runId: run.id })).capabilities,
    ).toEqual({
      cancel: true,
      pauseProcessing: true,
      resumeProcessing: false,
      submitInput: false,
      inspectItems: true,
    });
    expect(
      (await core.runs.pause({ identity, runId: run.id })).capabilities,
    ).toEqual({
      cancel: true,
      pauseProcessing: false,
      resumeProcessing: true,
      submitInput: false,
      inspectItems: true,
    });
    expect((await core.runs.pause({ identity, runId: run.id })).status).toBe(
      "paused",
    );
    await core.runs.resume({ identity, runId: run.id });
    await expect(core.runs.resume({ identity, runId: run.id })).rejects.toEqual(
      expect.objectContaining({
        name: "RunCapabilityError",
        capability: "resumeProcessing",
      }),
    );
    await db
      .updateTable("workflow_runs")
      .set({ status: "running", phase: "process" })
      .where("id", "=", run.id)
      .execute();
    expect((await core.runs.resume({ identity, runId: run.id })).status).toBe(
      "running",
    );
    const worker = core.runs.startWorker({
      name: "multiple-batches",
      concurrency: 3,
      pollIntervalMs: 5,
      leaseSeconds: 5,
    });
    await waitForStatus({
      runId: run.id,
      status: "completed",
      timeout: 15_000,
    });
    await worker.stop();
    const detail = await core.runs.get({ identity, runId: run.id });
    expect(
      detail.workflowStepAttempts.map((attempt) => attempt.executor),
    ).toEqual(["batch", "batch"]);
    const scopes = await db
      .selectFrom("batch_execution_states")
      .where("run_id", "=", run.id)
      .select(["workflow_step_attempt_id", "discovered_count"])
      .execute();
    expect(scopes).toHaveLength(2);
    expect(scopes.map((scope) => Number(scope.discovered_count))).toEqual([
      1, 1,
    ]);
    expect(
      detail.batchScopes.map(({ stepIndex, attempt, status }) => ({
        stepIndex,
        attempt,
        status,
      })),
    ).toEqual([
      { stepIndex: 0, attempt: 1, status: "completed" },
      { stepIndex: 1, attempt: 1, status: "completed" },
    ]);

    await db
      .updateTable("workflow_step_attempts")
      .set({ status: "failed", error: "postmortem failure" })
      .where("run_id", "=", run.id)
      .where("step_index", "=", 0)
      .execute();
    await db
      .updateTable("workflow_step_attempts")
      .set({ status: "canceled", error: "postmortem cancellation" })
      .where("run_id", "=", run.id)
      .where("step_index", "=", 1)
      .execute();
    await db
      .updateTable("workflow_runs")
      .set({ status: "failed", error: "postmortem failure" })
      .where("id", "=", run.id)
      .execute();

    const postmortem = await core.runs.get({ identity, runId: run.id });
    expect(postmortem.capabilities.inspectItems).toBe(true);
    expect(postmortem.batchScopes.map((scope) => scope.status)).toEqual([
      "failed",
      "canceled",
    ]);
    expect(
      (
        await core.runs.list({
          identity,
          projectId,
          workflowName: "multipleBatchWorkflow",
        })
      ).items[0],
    ).toMatchObject({
      id: run.id,
      capabilities: { inspectItems: true },
      batchScopes: [
        { stepIndex: 0, status: "failed" },
        { stepIndex: 1, status: "canceled" },
      ],
    });
  }, 20_000);

  it("applies source backpressure and distributes work across independent workers", async () => {
    const run = await core.runs.triggerProduction({
      identity,
      projectId,
      workflowName: "pagingWorkflow",
      input: { paging: true },
    });
    const first = core.runs.startWorker({
      name: "paging-first",
      concurrency: 4,
      pollIntervalMs: 1,
      leaseSeconds: 10,
    });
    const second = secondCore.runs.startWorker({
      name: "paging-second",
      concurrency: 4,
      pollIntervalMs: 1,
      leaseSeconds: 10,
    });
    await waitForStatus({
      runId: run.id,
      status: "completed",
      timeout: 30_000,
    });
    await Promise.all([first.stop(), second.stop()]);
    const completed = await core.runs.get({ identity, runId: run.id });
    expect(completed.batchScopes).toEqual([
      expect.objectContaining({
        discovered: 101,
        succeeded: 101,
      }),
    ]);
    expect(providerOne.invocationCount).toBeGreaterThan(0);
    expect(providerTwo.invocationCount).toBeGreaterThan(0);
    const sourceJobs = await db
      .selectFrom("execution_jobs")
      .where("workflow_run_id", "=", run.id)
      .where("kind", "=", "batch_source")
      .select("id")
      .execute();
    expect(sourceJobs).toHaveLength(2);
  }, 35_000);
});

async function waitForRateBlock(args: {
  runId: string;
  stepIndex: number;
  timeout?: number;
}): Promise<{ rate_blocked_until: Date | null; attempt: number } | undefined> {
  const deadline = Date.now() + (args.timeout ?? 5_000);
  let latest: { rate_blocked_until: Date | null; attempt: number } | undefined;
  while (Date.now() < deadline) {
    latest = await db
      .selectFrom("workflow_step_attempts")
      .where("run_id", "=", args.runId)
      .where("step_index", "=", args.stepIndex)
      .select(["rate_blocked_until", "attempt"])
      .executeTakeFirst();
    if (latest?.rate_blocked_until) return latest;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  return latest;
}

/**
 * Waits for a run's child to exist.
 *
 * Prefer this over waiting for the parent to report `waiting` when the child
 * completes promptly: the parent's `waiting` status is transient, so polling
 * for it is a race, while the child row persists once written.
 */
async function waitForChildRun(args: {
  parentRunId: string;
  timeout?: number;
}): Promise<{ id: string }> {
  const deadline = Date.now() + (args.timeout ?? 5_000);
  while (Date.now() < deadline) {
    const child = await db
      .selectFrom("workflow_runs")
      .where("parent_run_id", "=", args.parentRunId)
      .select("id")
      .executeTakeFirst();
    if (child) return child;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Run '${args.parentRunId}' never spawned a child`);
}

async function waitForStatus(args: {
  runId: string;
  status: string;
  timeout?: number;
}): Promise<void> {
  const deadline = Date.now() + (args.timeout ?? 5_000);
  while (Date.now() < deadline) {
    if (
      (await core.runs.get({ identity, runId: args.runId })).status ===
      args.status
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  const [run, jobs, attempts, batch, items] = await Promise.all([
    core.runs.get({ identity, runId: args.runId }),
    db
      .selectFrom("execution_jobs")
      .where("workflow_run_id", "=", args.runId)
      .select(["kind", "status", "attempt", "last_error", "payload"])
      .execute(),
    db
      .selectFrom("workflow_step_attempts")
      .where("run_id", "=", args.runId)
      .select(["executor", "step_index", "attempt", "status", "error"])
      .execute(),
    db
      .selectFrom("batch_execution_states")
      .where("run_id", "=", args.runId)
      .selectAll()
      .execute(),
    db
      .selectFrom("batch_items")
      .where("run_id", "=", args.runId)
      .select(["item_key", "status", "attempt", "error"])
      .execute(),
  ]);
  throw new Error(
    JSON.stringify({
      expected: args.status,
      run,
      jobs,
      attempts,
      batch,
      items,
    }),
  );
}

async function waitForJob(args: {
  runId: string;
  kind: "batch_step";
}): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const job = await db
      .selectFrom("execution_jobs")
      .where("workflow_run_id", "=", args.runId)
      .where("kind", "=", args.kind)
      .select("id")
      .executeTakeFirst();
    if (job) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${args.kind} job`);
}

async function waitForJobStatus(args: {
  jobId: string;
  status: string;
  timeout?: number;
}): Promise<void> {
  const deadline = Date.now() + (args.timeout ?? 5_000);
  while (Date.now() < deadline) {
    const job = await db
      .selectFrom("execution_jobs")
      .where("id", "=", args.jobId)
      .select(["status", "last_error"])
      .executeTakeFirstOrThrow();
    if (job.status === args.status) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error(`Job '${args.jobId}' did not reach status '${args.status}'`);
}

async function waitForBlockedOnPid(args: {
  pid: number;
  count?: number;
}): Promise<void> {
  const expected = args.count ?? 1;
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const blocked = await sql<{ count: string }>`
      WITH RECURSIVE blocked(pid) AS (
        SELECT pid
        FROM pg_stat_activity
        WHERE ${args.pid} = ANY(pg_blocking_pids(pid))
        UNION
        SELECT activity.pid
        FROM pg_stat_activity AS activity
        INNER JOIN blocked AS blocker
          ON blocker.pid = ANY(pg_blocking_pids(activity.pid))
      )
      SELECT count(*)::text AS count FROM blocked
    `.execute(db);
    if (Number(blocked.rows[0]?.count ?? "0") >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${expected} blocked transaction(s)`);
}

async function invokeRuntime(
  invocation: RuntimeInvocation,
): Promise<RuntimeInvocationReceipt> {
  if (invocation.kind === "durable-boundary") {
    const stepIndex = invocation.target.stepIndex;
    const input = record(invocation.input).value;
    if (invocation.target.exportName === "approvalWorkflow") {
      return receipt(
        invocation,
        completed(
          stepIndex === 0
            ? {
                type: "pause",
                transition: {
                  __catamorphicDurableTransition: "pause",
                  statePresent: true,
                  state: { requestId: "request-1" },
                },
              }
            : {
                type: "completed",
                output: record(input).value ?? { approved: true },
              },
        ),
      );
    }
    if (invocation.target.exportName === "campaignWorkflow") {
      return receipt(
        invocation,
        completed(
          stepIndex === 0
            ? {
                type: "pause",
                transition: {
                  __catamorphicDurableTransition: "pause",
                  signal: "reply",
                  statePresent: true,
                  state: { contactId: record(input).contactId ?? "unknown" },
                },
              }
            : { type: "completed", output: record(input).value ?? {} },
        ),
      );
    }
    if (invocation.target.exportName === "timeoutWorkflow") {
      return receipt(
        invocation,
        completed(
          stepIndex === 0
            ? {
                type: "pause",
                transition: {
                  __catamorphicDurableTransition: "pause",
                  timeout: "1ms",
                  statePresent: true,
                  state: { requestId: "request-timeout" },
                },
              }
            : { type: "completed", output: input },
        ),
      );
    }
    if (invocation.target.exportName === "retryWorkflow") {
      retryInvocations += 1;
      return retryInvocations === 1
        ? receipt(invocation, failed("retry me"))
        : receipt(
            invocation,
            completed({ type: "completed", output: { retried: true } }),
          );
    }
    if (invocation.target.exportName === "transportBoundaryWorkflow") {
      return receipt(
        invocation,
        completed({ type: "completed", output: { transport: "retried" } }),
      );
    }
    if (invocation.target.exportName === "parentWorkflow") {
      return receipt(
        invocation,
        completed({
          type: "child_workflow",
          transition: {
            __catamorphicDurableTransition: "child_workflow",
            input: { child: true },
            workflow: { exportName: "childWorkflow" },
          },
        }),
      );
    }
    const childByParent: Record<string, string> = {
      parentCompletingChildWorkflow: "completingChildWorkflow",
      parentFailingChildWorkflow: "failingChildWorkflow",
      parentCancelableChildWorkflow: "cancelableChildWorkflow",
      parentWaitingChildWorkflow: "waitingChildWorkflow",
    };
    const childExportName = childByParent[invocation.target.exportName];
    if (childExportName) {
      return receipt(
        invocation,
        completed({
          type: "child_workflow",
          transition: {
            __catamorphicDurableTransition: "child_workflow",
            input: { child: true },
            workflow: { exportName: childExportName },
          },
        }),
      );
    }
    if (invocation.target.exportName === "completingChildWorkflow") {
      return receipt(
        invocation,
        completed({ type: "completed", output: { child: "child-completed" } }),
      );
    }
    if (invocation.target.exportName === "failingChildWorkflow") {
      return receipt(invocation, failed("child failed"));
    }
    if (invocation.target.exportName === "cancelableChildWorkflow") {
      markCanceledChildStarted?.();
      await new Promise<void>((resolve) => {
        releaseCanceledChild = resolve;
      });
      return receipt(
        invocation,
        completed({ type: "completed", output: { tooLate: true } }),
      );
    }
    if (invocation.target.exportName === "waitingChildWorkflow") {
      return receipt(
        invocation,
        completed({
          type: "pause",
          transition: {
            __catamorphicDurableTransition: "pause",
            signal: "release",
            statePresent: true,
            state: { child: true },
          },
        }),
      );
    }
    if (invocation.target.exportName === "childWorkflow") {
      return receipt(
        invocation,
        completed({ type: "completed", output: { child: "completed" } }),
      );
    }
    if (invocation.target.exportName === "cancelWorkflow") {
      markCanceledBoundaryStarted?.();
      await new Promise<void>((resolve) => {
        releaseCanceledBoundary = resolve;
      });
      return receipt(
        invocation,
        completed({ type: "completed", output: { tooLate: true } }),
      );
    }
    if (invocation.target.exportName === "mixedWorkflow") {
      return receipt(
        invocation,
        completed({
          type: "completed",
          output:
            stepIndex === 0 ? { batchInput: true } : { mixed: "completed" },
        }),
      );
    }
  }
  if (invocation.kind === "batch-source") {
    if (invocation.target.operation === "initialize") {
      if (invocation.target.exportName === "nullBatchWorkflow") {
        return receipt(
          invocation,
          completed({ snapshot: null, consistency: "snapshot" }),
        );
      }
      return receipt(
        invocation,
        completed({
          snapshot: { initialized: true },
          cursor: 0,
          consistency: "snapshot",
        }),
      );
    }
    const workflowName = invocation.target.exportName;
    if (workflowName === "nullBatchWorkflow") {
      const secondPage = Object.hasOwn(record(invocation.input), "cursor");
      return receipt(
        invocation,
        completed(
          secondPage
            ? {
                items: [
                  { key: "null-2", value: null },
                  { key: "null-3", value: null },
                ],
                nextCursor: null,
                done: true,
              }
            : {
                items: [
                  { key: "null-1", value: null },
                  { key: "null-1", value: "duplicate in page" },
                  { key: "null-2", value: null },
                ],
                nextCursor: null,
                done: false,
              },
        ),
      );
    }
    const cursor = Number(record(invocation.input).cursor ?? 0);
    if (workflowName === "pagingWorkflow") {
      const count = cursor === 0 ? 100 : 1;
      return receipt(
        invocation,
        completed({
          items: Array.from({ length: count }, (_, index) => ({
            key: `page-${cursor}-${index}`,
            value: { index: cursor * 100 + index },
          })),
          nextCursor: cursor + 1,
          done: cursor === 1,
        }),
      );
    }
    const count =
      workflowName === "batchWorkflow" ||
      workflowName === "occurrenceBatchWorkflow"
        ? 2
        : workflowName === "cancelBatchWorkflow"
          ? 3
          : 1;
    const keyPrefix =
      workflowName === "occurrenceBatchWorkflow"
        ? "occurrence"
        : workflowName === "physicalFailureWorkflow"
          ? "failure"
          : "item";
    return receipt(
      invocation,
      completed({
        items: Array.from({ length: count }, (_, index) => ({
          key: `${keyPrefix}-${index + 1}`,
          value: { index },
        })),
        nextCursor: 1,
        done: true,
      }),
    );
  }
  if (invocation.kind === "batch-step") {
    if (invocation.target.operation === "process") {
      if (invocation.target.exportName === "cancelBatchWorkflow") {
        canceledBatchItemCount += 1;
        if (canceledBatchItemCount === 3) markCanceledBatchItemsStarted?.();
        await canceledBatchItemsGate;
        return receipt(invocation, completed({ tooLate: true }));
      }
      if (invocation.target.exportName === "nullBatchWorkflow") {
        return receipt(invocation, completed(null));
      }
      if (
        invocation.target.exportName === "occurrenceBatchWorkflow" ||
        invocation.target.exportName === "physicalFailureWorkflow"
      ) {
        const input = record(invocation.input);
        const replay = record(input.replay);
        if (Object.hasOwn(replay, "node_4:1")) {
          return receipt(invocation, completed(replay["node_4:1"]));
        }
        return receipt(invocation, {
          status: "suspended",
          suspension: {
            nodeId: "node_4",
            occurrence: 1,
            name: "Classify",
            functionName: "classifyItems",
            input: input.item,
            policy: { maxItems: 2, maxWaitMs: 50 },
          },
          steps: [
            {
              nodeId: "node_4",
              occurrence: 0,
              name: "Classify",
              status: "completed",
              attempt: invocation.attempt,
              input: input.item,
              output: "first-call",
              startedAt: new Date().toISOString(),
              completedAt: new Date().toISOString(),
            },
          ],
        });
      }
      if (invocation.target.exportName !== "batchWorkflow") {
        return receipt(invocation, completed({ processed: true }));
      }
      const input = record(invocation.input);
      const replay = record(input.replay);
      if (typeof replay["node_4:0"] === "string") {
        return receipt(invocation, completed({ category: replay["node_4:0"] }));
      }
      return receipt(invocation, {
        status: "suspended",
        suspension: {
          nodeId: "node_4",
          occurrence: 0,
          name: "Classify",
          functionName: "classifyItems",
          input: input.item,
          policy: { maxItems: 2, maxWaitMs: 500 },
        },
        steps: [],
      });
    }
    const items = record(invocation.input).items;
    if (!Array.isArray(items)) throw new Error("Physical items are missing");
    const keys = items.map((item) => String(record(item).key));
    if (keys.every((key) => key.startsWith("failure-"))) {
      return receipt(invocation, failed("physical invocation failed"));
    }
    if (keys.every((key) => key.startsWith("occurrence-"))) {
      return receipt(
        invocation,
        completed(
          keys.map((key) =>
            key === "occurrence-2"
              ? { key, status: "skipped", reason: "not applicable" }
              : { key, status: "succeeded", result: null },
          ),
        ),
      );
    }
    physicalBatches.push(keys);
    physicalInvocations += 1;
    return receipt(
      invocation,
      completed(
        items.map((item, index) => {
          const key = String(record(item).key);
          if (physicalInvocations === 1 && index === 1) {
            return {
              key,
              status: "failed",
              error: { message: "retry once", retryable: true },
            };
          }
          return { key, status: "succeeded", result: `category-${key}` };
        }),
      ),
    );
  }
  if (invocation.kind === "batch-sink") {
    const workflowName = invocation.target.exportName;
    if (invocation.target.operation === "inspect") {
      return receipt(
        invocation,
        completed({
          present:
            workflowName === "batchWorkflow" ||
            workflowName === "nullBatchWorkflow",
          hasInitialize:
            workflowName === "batchWorkflow" ||
            workflowName === "nullBatchWorkflow",
        }),
      );
    }
    if (invocation.target.operation === "initialize") {
      return receipt(
        invocation,
        completed(workflowName === "nullBatchWorkflow" ? null : { written: 0 }),
      );
    }
    if (invocation.target.operation === "writeBatch") {
      const records = record(invocation.input).records;
      if (!Array.isArray(records)) throw new Error("Sink records are missing");
      const keys = records.map((entry) => String(record(entry).key));
      sinkChunks.push(keys);
      return receipt(
        invocation,
        completed({
          state:
            workflowName === "nullBatchWorkflow"
              ? null
              : { written: keys.length },
          acknowledgedKeys: keys,
        }),
      );
    }
    if (invocation.target.operation === "finalize") {
      return receipt(
        invocation,
        completed({ fileName: "results.json", itemCount: 2 }),
      );
    }
  }
  throw new Error(`Unexpected runtime invocation '${invocation.kind}'`);
}

function receipt(
  invocation: RuntimeInvocation,
  terminal: RuntimeTerminalResult,
): RuntimeInvocationReceipt {
  return {
    runtimeId: invocation.runtimeId,
    invocationId: invocation.invocationId,
    events: [],
    terminal,
  };
}

function completed(result: unknown): RuntimeTerminalResult {
  return { status: "completed", result, steps: [] };
}

function failed(error: string): RuntimeTerminalResult {
  return { status: "failed", error, steps: [] };
}

function invocationOperation(invocation: RuntimeInvocation): string {
  const operation = invocation.target.operation;
  return `${invocation.kind}:${operation ?? invocation.target.exportName}`;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(Object.entries(value));
}

class FakeSandboxProvider implements SandboxProvider {
  readonly workspaceRoot = "/workspace";
  readonly canceledInvocationIds: string[] = [];
  readonly invocationIds: string[] = [];
  readonly executionIds: string[] = [];
  readonly invocationsByOperation = new Map<string, string[]>();
  private readonly cachedReceipts = new Map<string, RuntimeInvocationReceipt>();
  private readonly failAfterExecution = new Set<string>();
  private readonly alwaysFail = new Set<string>();
  invocationCount = 0;

  readonly deploymentRuntime: DeploymentRuntimeProvider = {
    ensureRuntime: async (args) => ({
      runtimeId: `${this.name}-runtime`,
      sandboxId: args.sandboxId,
      deploymentArtifactId: args.deploymentArtifactId,
      artifactDigest: args.artifactDigest,
      transformVersion: args.transformVersion,
      runtimeVersion: args.runtimeVersion,
      generation: "1",
      status: "healthy",
    }),
    invoke: async (args) => {
      this.invocationCount += 1;
      this.invocationIds.push(args.invocationId);
      const operation = invocationOperation(args);
      const ids = this.invocationsByOperation.get(operation) ?? [];
      ids.push(args.invocationId);
      this.invocationsByOperation.set(operation, ids);
      if (this.alwaysFail.has(operation)) {
        throw new RuntimeInfrastructureError({
          operation: `${operation} test handoff`,
          cause: new Error("simulated unavailable transport"),
        });
      }
      const cached = this.cachedReceipts.get(args.invocationId);
      if (cached) return cached;
      const receipt = await this.invoke(args);
      this.executionIds.push(args.invocationId);
      this.cachedReceipts.set(args.invocationId, receipt);
      if (this.failAfterExecution.delete(operation)) {
        throw new RuntimeInfrastructureError({
          operation: `${operation} test handoff`,
          cause: new Error("simulated lost receipt"),
        });
      }
      return receipt;
    },
    cancel: async ({ invocationId }) => {
      this.canceledInvocationIds.push(invocationId);
    },
    getHealth: async ({ runtimeId }) => ({
      runtimeId,
      runtimeStatus: "healthy",
      protocolVersion: 8,
      status: "healthy",
      activeInvocations: 0,
      queuedInvocations: 0,
      maxConcurrency: 8,
    }),
  };

  constructor(
    private readonly name: string,
    private readonly invoke: (
      invocation: RuntimeInvocation,
    ) => Promise<RuntimeInvocationReceipt>,
  ) {}

  failAfterExecutionOnce(operation: string): void {
    this.failAfterExecution.add(operation);
  }

  failAlways(operation: string): void {
    this.alwaysFail.add(operation);
  }

  resetInvocations(): void {
    this.invocationIds.length = 0;
    this.executionIds.length = 0;
    this.invocationsByOperation.clear();
    this.cachedReceipts.clear();
    this.failAfterExecution.clear();
    this.alwaysFail.clear();
  }

  async createSandbox() {
    return {
      id: crypto.randomUUID(),
      providerId: `${this.name}-sandbox-${crypto.randomUUID()}`,
      sandboxType: "execution" as const,
      status: "started" as const,
    };
  }

  async startSandbox(): Promise<void> {}
  async stopSandbox(): Promise<void> {}
  async destroySandbox(): Promise<void> {}
  async getSandboxStatus() {
    return "started" as const;
  }

  async executeCommand(_sandboxId: string, command: string) {
    if (command === "bun run harness.ts") {
      return {
        exitCode: 0,
        result: `CATAMORPHIC_REPORT:${JSON.stringify({
          status: "completed",
          result: { test: true },
          steps: [],
        })}`,
      };
    }
    return { exitCode: 0, result: "" };
  }

  async uploadFiles(): Promise<void> {}
  async downloadFile(): Promise<string> {
    return "";
  }
  async gitClone(): Promise<void> {}
  async gitCheckout(): Promise<void> {}
}

function projectFiles(): Record<string, string> {
  return {
    "package.json": JSON.stringify({
      name: "unified-runs",
      private: true,
      type: "module",
      dependencies: { "@catamorphic/workflow": "0.0.1" },
    }),
    "src/workflows.ts": `import {
  type BoundaryContext,
  defineBatchStep,
  defineWorkflow,
} from "@catamorphic/workflow";

export const completingChildWorkflow = defineWorkflow(({ defineBoundary }) => ({
  steps: [defineBoundary({ run: ({ input }: BoundaryContext<{ child: boolean }>) => ({ child: input.child }) })],
}));

export const failingChildWorkflow = defineWorkflow(({ defineBoundary }) => ({
  steps: [defineBoundary({ retry: { maxAttempts: 1 }, run: ({ input }: BoundaryContext<{ child: boolean }>) => input })],
}));

export const cancelableChildWorkflow = defineWorkflow(({ defineBoundary }) => ({
  steps: [defineBoundary({ run: ({ input }: BoundaryContext<{ child: boolean }>) => input })],
}));

export const waitingChildWorkflow = defineWorkflow(({ defineBoundary }) => ({
  steps: [
    defineBoundary({ run: ({ input, pause }: BoundaryContext<{ child: boolean }>) =>
      pause<{ released: boolean }, { child: boolean }>({ signal: "release", state: { child: input.child } }) }),
    defineBoundary({ run: ({ input }: BoundaryContext<{ reason: "resumed"; value: { released: boolean }; state: { child: boolean } }>) => input.value }),
  ],
}));

export const approvalWorkflow = defineWorkflow(({ defineBoundary }) => ({
  steps: [
    defineBoundary({ run: ({ input, pause }: BoundaryContext<{ orderId: string }>) =>
      pause<{ approved: boolean }, { requestId: string }>({ state: { requestId: input.orderId } }) }),
    defineBoundary({ run: ({ input }: BoundaryContext<{ reason: "resumed"; value: { approved: boolean }; state: { requestId: string } }>) => input.value }),
  ],
}));

export const campaignWorkflow = defineWorkflow(({ defineBoundary }) => ({
  controls: { cancel: true },
  steps: [
    defineBoundary({
      rateLimits: [{ globalKey: "campaign-email", capacity: 100, refillRatePerSecond: 50 }],
      run: ({ input, pause }: BoundaryContext<{ contactId: string }>) =>
        pause<{ optedOut: boolean }, { contactId: string }>({ signal: "reply", state: { contactId: input.contactId } }),
    }),
    defineBoundary({
      rateLimits: [{ globalKey: "campaign-whatsapp", capacity: 2, refillRatePerSecond: 0.000001 }],
      run: ({ input }: BoundaryContext<{ reason: "resumed"; value: { optedOut: boolean }; state: { contactId: string } }>) => input.value,
    }),
  ],
}));

export const timeoutWorkflow = defineWorkflow(({ defineBoundary }) => ({
  steps: [
    defineBoundary({ run: ({ input, pause }: BoundaryContext<{ orderId: string }>) =>
      pause<{ approved: boolean }, { requestId: string }>({ timeout: "1ms", state: { requestId: input.orderId } }) }),
    defineBoundary({ run: ({ input }: BoundaryContext<{ reason: "resumed"; value: { approved: boolean }; state: { requestId: string } } | { reason: "timed_out"; state: { requestId: string } }>) => input }),
  ],
}));

export const retryWorkflow = defineWorkflow(({ defineBoundary }) => ({
  steps: [defineBoundary({ retry: { maxAttempts: 2, backoff: { initial: "1ms" } }, run: ({ input }: BoundaryContext<{ retry: boolean }>) => input })],
}));

export const transportBoundaryWorkflow = defineWorkflow(({ defineBoundary }) => ({
  steps: [defineBoundary({ retry: { maxAttempts: 1 }, run: ({ input }: BoundaryContext<{ transport: boolean }>) => input })],
}));

export const childWorkflow = defineWorkflow(({ defineBoundary }) => ({
  steps: [defineBoundary({ run: ({ input }: BoundaryContext<{ child: boolean }>) => input })],
}));

export const parentWorkflow = defineWorkflow(({ defineBoundary }) => ({
  steps: [defineBoundary({ run: ({ input, callWorkflow }: BoundaryContext<{ parent: boolean }>) => callWorkflow(childWorkflow, { input: { child: input.parent } }) })],
}));

export const parentCompletingChildWorkflow = defineWorkflow(({ defineBoundary }) => ({
  steps: [defineBoundary({ run: ({ input, callWorkflow }: BoundaryContext<{ parent: boolean }>) => callWorkflow(completingChildWorkflow, { input: { child: input.parent } }) })],
}));

export const parentFailingChildWorkflow = defineWorkflow(({ defineBoundary }) => ({
  steps: [defineBoundary({ run: ({ input, callWorkflow }: BoundaryContext<{ parent: boolean }>) => callWorkflow(failingChildWorkflow, { input: { child: input.parent } }) })],
}));

export const parentCancelableChildWorkflow = defineWorkflow(({ defineBoundary }) => ({
  controls: { cancel: true },
  steps: [defineBoundary({ run: ({ input, callWorkflow }: BoundaryContext<{ parent: boolean }>) => callWorkflow(cancelableChildWorkflow, { input: { child: input.parent } }) })],
}));

export const parentWaitingChildWorkflow = defineWorkflow(({ defineBoundary }) => ({
  controls: { cancel: true },
  steps: [defineBoundary({ run: ({ input, callWorkflow }: BoundaryContext<{ parent: boolean }>) => callWorkflow(waitingChildWorkflow, { input: { child: input.parent } }) })],
}));

export const cancelWorkflow = defineWorkflow(({ defineBoundary }) => ({
  controls: { cancel: true },
  steps: [defineBoundary({ run: ({ input }: BoundaryContext<{ cancel: boolean }>) => input })],
}));

export const classifyItems = defineBatchStep<{ index: number }, string>({
  batch: { maxItems: 2, maxWaitMs: 50 },
  async run({ items }) {
    return items.map(({ key }) => ({ key, status: "succeeded", result: key }));
  },
});

const source = {
  consistency: "snapshot" as const,
  async initialize() { return { snapshot: {}, cursor: 0 }; },
  async readPage() { return { items: [], done: true }; },
};

const sink = {
  async writeBatch({ records }: { records: readonly { key: string }[] }) {
    return { state: {}, acknowledgedKeys: records.map(({ key }) => key) };
  },
  async finalize() { return { fileName: "results.json" }; },
};

export const batchWorkflow = defineWorkflow(({ defineBatch }) => ({
  steps: [defineBatch({
    source: ({ input }: { input: { batch: boolean } }) => ({ source, config: input }),
    process: async ({ item }: { key: string; item: { index: number } }) => classifyItems(item),
    failurePolicy: { mode: "fail_fast", maxFailures: 2 },
    sink: sink,
  })],
}));

export const nullBatchWorkflow = defineWorkflow(({ defineBatch }) => ({
  steps: [defineBatch({
    source: ({ input }: { input: null }) => ({ source, config: input }),
    process: async ({ item }: { key: string; item: null }) => item,
    sink: sink,
  })],
}));

export const cancelBatchWorkflow = defineWorkflow(({ defineBatch }) => ({
  controls: { cancel: true },
  steps: [defineBatch({
    source: ({ input }: { input: { cancel: boolean } }) => ({ source, config: input }),
    process: async ({ item }: { key: string; item: { index: number } }) => item,
  })],
}));

export const occurrenceBatchWorkflow = defineWorkflow(({ defineBatch }) => ({
  steps: [defineBatch({
    source: ({ input }: { input: { occurrence: boolean } }) => ({ source, config: input }),
    process: async ({ item }: { key: string; item: { index: number } }) => {
      await classifyItems(item);
      return classifyItems(item);
    },
  })],
}));

export const physicalFailureWorkflow = defineWorkflow(({ defineBatch }) => ({
  steps: [defineBatch({
    source: ({ input }: { input: { fail: boolean } }) => ({ source, config: input }),
    process: async ({ item }: { key: string; item: { index: number } }) => {
      await classifyItems(item);
      return classifyItems(item);
    },
  })],
}));

export const pagingWorkflow = defineWorkflow(({ defineBatch }) => ({
  steps: [defineBatch({
    source: ({ input }: { input: { paging: boolean } }) => ({ source, config: input }),
    process: async ({ item }: { key: string; item: { index: number } }) => item,
  })],
}));

export const mixedWorkflow = defineWorkflow(({ defineBoundary, defineBatch }) => ({
  steps: [
    defineBoundary({ run: ({ input }: BoundaryContext<{ mixed: boolean }>) => ({ batchInput: input.mixed }) }),
    defineBatch({
      source: ({ input }: { input: { batchInput: boolean } }) => ({ source, config: input }),
      process: async ({ item }: { key: string; item: { index: number } }) => item,
    }),
    defineBoundary({ run: ({ input }: BoundaryContext<{ summary: object }>) => ({ mixed: input.summary ? "completed" : "failed" }) }),
  ],
}));

export const multipleBatchWorkflow = defineWorkflow(({ defineBatch }) => ({
  steps: [
    defineBatch({
      source: ({ input }: { input: { batches: boolean } }) => ({ source, config: input }),
      process: async ({ item }: { key: string; item: { index: number } }) => item,
    }),
    defineBatch({
      source: ({ input }: { input: { summary: object } }) => ({ source, config: input }),
      process: async ({ item }: { key: string; item: { index: number } }) => item,
    }),
  ],
}));
`,
  };
}
