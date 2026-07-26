import { createHash } from "node:crypto";
import type { DB, Json } from "@catamorphic/db";
import type {
  WorkflowCapabilities,
  WorkflowExecutionDescriptor,
  WorkflowExecutionUnitDescriptor,
} from "@catamorphic/parser";
import type { RunResult } from "@catamorphic/sandbox";
import { type Kysely, sql, type Transaction } from "kysely";
import type { Identity } from "../identity.js";
import type {
  ExecutionJob,
  ExecutionJobsService,
} from "./execution-jobs-service.js";
import { ExecutionJobDeferredError } from "./execution-worker-service.js";

const ACTIVE_RUN_STATUSES = ["pending", "running", "waiting"] as const;
const TERMINAL_RUN_STATUSES = ["completed", "failed", "canceled"] as const;

export class RunCoordinator {
  constructor(
    private readonly db: Kysely<DB>,
    private readonly jobs: ExecutionJobsService,
  ) {}

  async initialize(args: {
    trx: Transaction<DB>;
    tenantId: string;
    runId: string;
    execution: WorkflowExecutionDescriptor;
    input: Json;
  }): Promise<void> {
    if (args.execution.steps.length === 0) {
      throw new Error("A defined workflow execution plan must contain steps");
    }
    await args.trx
      .insertInto("workflow_run_states")
      .values({
        run_id: args.runId,
        execution_plan: toJson(args.execution),
        current_step_index: 0,
        current_input: jsonColumn(args.input),
      })
      .execute();
    await this.createStepAttempt({
      trx: args.trx,
      tenantId: args.tenantId,
      runId: args.runId,
      descriptor: args.execution.steps[0] as WorkflowExecutionUnitDescriptor,
      input: args.input,
      attempt: 1,
    });
  }

  async beginAttempt(args: {
    job: ExecutionJob;
    phase: "boundary" | "source" | "process" | "sink";
  }): Promise<boolean> {
    if (!args.job.workflowStepAttemptId) return false;
    return this.db.transaction().execute(async (trx) => {
      const run = await lockRun({ trx, runId: args.job.workflowRunId });
      if (!run || !isActiveRunStatus(run.status)) return false;
      if (!(await ownsJob({ trx, job: args.job }))) return false;
      const attempt = await trx
        .selectFrom("workflow_step_attempts")
        .where("id", "=", args.job.workflowStepAttemptId)
        .where("run_id", "=", args.job.workflowRunId)
        .select(["id", "status"])
        .forUpdate()
        .executeTakeFirst();
      if (!attempt || !["pending", "running"].includes(attempt.status)) {
        return false;
      }
      const now = await databaseNow(trx);
      await trx
        .updateTable("workflow_step_attempts")
        .set({
          status: "running",
          started_at: sql<Date>`coalesce(started_at, ${now})`,
          updated_at: now,
        })
        .where("id", "=", attempt.id)
        .where("status", "in", ["pending", "running"])
        .execute();
      await trx
        .updateTable("workflow_runs")
        .set({
          status: "running",
          phase: args.phase,
          started_at: sql<Date>`coalesce(started_at, ${now})`,
          updated_at: now,
        })
        .where("id", "=", args.job.workflowRunId)
        .where("status", "in", [...ACTIVE_RUN_STATUSES])
        .execute();
      return true;
    });
  }

  async invokeRuntime<T>(args: {
    job: ExecutionJob;
    invocationId: string;
    invoke: () => Promise<T>;
  }): Promise<T> {
    if (!(await this.registerInvocation(args))) {
      throw new RuntimeInvocationFencedError(args.invocationId);
    }
    let result: T;
    try {
      result = await args.invoke();
    } catch (error) {
      const owned = await this.unregisterInvocation(args);
      if (!owned) throw new RuntimeInvocationFencedError(args.invocationId);
      throw error;
    }
    const owned = await this.unregisterInvocation(args);
    if (!owned) throw new RuntimeInvocationFencedError(args.invocationId);
    return result;
  }

  /**
   * Moves a run between batch phases.
   *
   * Every item of a batch calls this, and they all target the same
   * `workflow_runs` row. Taking an explicit `FOR UPDATE` first serialized the
   * whole batch behind one row lock; folding the guards into a single
   * conditional UPDATE lets Postgres lock only when a row actually matches.
   *
   * The status/phase inequality matters as much as the lock: items repeatedly
   * re-assert the phase they are already in, and without the guard each no-op
   * still rewrote the row, producing a dead tuple per item on one row.
   */
  async setPhase(args: {
    runId: string;
    workflowStepAttemptId: string;
    status?: "pending" | "running" | "waiting";
    phase: "source" | "process" | "sink";
  }): Promise<void> {
    const status = args.status ?? "running";
    await this.db
      .updateTable("workflow_runs")
      .set({
        status,
        phase: args.phase,
        updated_at: sql<Date>`clock_timestamp()`,
      })
      .where("id", "=", args.runId)
      .where("status", "in", [...ACTIVE_RUN_STATUSES])
      .where((eb) =>
        eb.or([eb("status", "!=", status), eb("phase", "!=", args.phase)]),
      )
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom("workflow_run_states")
            .select("run_id")
            .whereRef("workflow_run_states.run_id", "=", "workflow_runs.id")
            .where(
              "active_workflow_step_attempt_id",
              "=",
              args.workflowStepAttemptId,
            ),
        ),
      )
      .execute();
  }

  async completeStep(args: {
    workflowStepAttemptId: string;
    output: Json;
    job?: ExecutionJob;
  }): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      const context = await this.lockActiveAttempt({
        trx,
        workflowStepAttemptId: args.workflowStepAttemptId,
      });
      if (
        !context ||
        !["running", "waiting"].includes(context.attempt.status) ||
        (args.job && !(await ownsJob({ trx, job: args.job })))
      ) {
        return;
      }
      const now = await databaseNow(trx);
      await trx
        .updateTable("workflow_step_attempts")
        .set({
          status: "completed",
          output: jsonColumn(args.output),
          error: null,
          completed_at: now,
          updated_at: now,
        })
        .where("id", "=", context.attempt.id)
        .execute();
      await this.advance({
        trx,
        tenantId: context.tenantId,
        runId: context.attempt.run_id,
        completedStepIndex: context.attempt.step_index,
        output: args.output,
      });
    });
  }

  async failStep(args: {
    workflowStepAttemptId: string;
    error: string;
    job?: ExecutionJob;
    allowBoundaryRetry?: boolean;
  }): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      const context = await this.lockActiveAttempt({
        trx,
        workflowStepAttemptId: args.workflowStepAttemptId,
      });
      if (
        !context ||
        !["pending", "running", "waiting"].includes(context.attempt.status) ||
        (args.job && !(await ownsJob({ trx, job: args.job })))
      ) {
        return;
      }
      const now = await databaseNow(trx);
      await this.cleanupStepScope({
        trx,
        runId: context.attempt.run_id,
        workflowStepAttemptId: context.attempt.id,
        error: args.error,
        now,
        excludeJobId: args.job?.id,
      });
      await trx
        .updateTable("workflow_step_attempts")
        .set({
          status: "failed",
          error: args.error,
          completed_at: now,
          updated_at: now,
        })
        .where("id", "=", context.attempt.id)
        .execute();

      const policy = jsonRecord(context.attempt.policy);
      const maxAttempts = finiteInteger(policy.maxAttempts) ?? 1;
      if (
        args.allowBoundaryRetry !== false &&
        context.attempt.executor === "boundary" &&
        context.attempt.attempt < maxAttempts
      ) {
        const descriptor = executionSteps(context.state.execution_plan)[
          context.attempt.step_index
        ];
        if (!descriptor) throw new Error("Active workflow step is missing");
        await this.createStepAttempt({
          trx,
          tenantId: context.tenantId,
          runId: context.attempt.run_id,
          descriptor,
          input: context.attempt.input,
          attempt: context.attempt.attempt + 1,
          availableAt: retryAt({
            policy,
            attempt: context.attempt.attempt,
            now,
          }),
        });
        return;
      }
      await this.failRun({
        trx,
        runId: context.attempt.run_id,
        error: args.error,
        now,
        excludeJobId: args.job?.id,
      });
    });
  }

  async suspendForPause(args: {
    workflowStepAttemptId: string;
    job: ExecutionJob;
    transition: Record<string, unknown>;
  }): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      const context = await this.lockActiveAttempt({
        trx,
        workflowStepAttemptId: args.workflowStepAttemptId,
      });
      if (
        context?.attempt.status !== "running" ||
        !(await ownsJob({ trx, job: args.job }))
      ) {
        return;
      }
      const now = await databaseNow(trx);
      const timeout =
        typeof args.transition.timeout === "string"
          ? parseDuration(args.transition.timeout)
          : undefined;
      const timeoutAt = timeout ? new Date(now.getTime() + timeout) : null;
      const pauseId = crypto.randomUUID();
      await trx
        .insertInto("workflow_pauses")
        .values({
          id: pauseId,
          run_id: context.attempt.run_id,
          workflow_step_attempt_id: context.attempt.id,
          state_present: args.transition.statePresent === true,
          state: jsonColumn(toJson(args.transition.state)),
          timeout_at: timeoutAt,
          signal_name: stringValue(args.transition.signal) ?? null,
        })
        .execute();
      await trx
        .updateTable("workflow_step_attempts")
        .set({ status: "waiting", updated_at: now })
        .where("id", "=", context.attempt.id)
        .execute();
      await trx
        .updateTable("workflow_runs")
        .set({ status: "waiting", phase: "pause", updated_at: now })
        .where("id", "=", context.attempt.run_id)
        .where("status", "in", [...ACTIVE_RUN_STATUSES])
        .execute();
      if (timeoutAt) {
        await this.jobs.enqueue({
          trx,
          tenantId: context.tenantId,
          workflowRunId: context.attempt.run_id,
          workflowStepAttemptId: context.attempt.id,
          kind: "durable_pause_timeout",
          payload: { pauseId },
          availableAt: timeoutAt,
          maxAttempts: 10,
          dedupeKey: `run:${context.attempt.run_id}:pause:${pauseId}:timeout`,
        });
      }
    });
  }

  async resumePause(args: {
    identity: Identity;
    runId: string;
    pauseId: string;
    idempotencyKey: string;
    value: Json;
  }): Promise<void> {
    const payloadHash = createHash("sha256")
      .update(JSON.stringify(args.value))
      .digest("hex");
    await this.db.transaction().execute(async (trx) => {
      await requireOwnedRun({
        trx,
        identity: args.identity,
        runId: args.runId,
      });
      const run = await lockRun({ trx, runId: args.runId });
      if (!run) throw new RunResumeConflictError("Run is not active");
      const pause = await trx
        .selectFrom("workflow_pauses")
        .where("id", "=", args.pauseId)
        .where("run_id", "=", args.runId)
        .selectAll()
        .forUpdate()
        .executeTakeFirst();
      if (!pause) throw new RunPauseNotFoundError(args.pauseId);
      if (pause.status !== "open") {
        if (
          pause.resume_idempotency_key === args.idempotencyKey &&
          pause.resume_payload_hash === payloadHash
        ) {
          return;
        }
        throw new RunResumeConflictError("Pause is already resolved");
      }
      if (!isActiveRunStatus(run.status)) {
        throw new RunResumeConflictError("Run is not active");
      }
      const now = await databaseNow(trx);
      if (pause.timeout_at && pause.timeout_at <= now) {
        await trx
          .updateTable("workflow_pauses")
          .set({ status: "timed_out", resolved_at: now })
          .where("id", "=", pause.id)
          .where("status", "=", "open")
          .execute();
        await this.resolvePause({ trx, pause, reason: "timed_out" });
        return;
      }
      await trx
        .updateTable("workflow_pauses")
        .set({
          status: "resumed",
          resume_value: jsonColumn(args.value),
          resume_idempotency_key: args.idempotencyKey,
          resume_payload_hash: payloadHash,
          resolved_at: now,
        })
        .where("id", "=", pause.id)
        .execute();
      await this.resolvePause({
        trx,
        pause: { ...pause, resume_value: args.value },
        reason: "resumed",
      });
    });
  }

  async resolvePauseTimeout(args: { job: ExecutionJob }): Promise<void> {
    const pauseId = stringValue(jsonRecord(args.job.payload).pauseId);
    if (!pauseId) throw new Error("Pause timeout job is invalid");
    await this.db.transaction().execute(async (trx) => {
      const run = await lockRun({ trx, runId: args.job.workflowRunId });
      if (
        !run ||
        !isActiveRunStatus(run.status) ||
        !(await ownsJob({ trx, job: args.job }))
      ) {
        return;
      }
      const pause = await trx
        .selectFrom("workflow_pauses")
        .where("id", "=", pauseId)
        .where("run_id", "=", args.job.workflowRunId)
        .selectAll()
        .forUpdate()
        .executeTakeFirst();
      if (pause?.status !== "open" || !pause.timeout_at) return;
      const now = await databaseNow(trx);
      if (pause.timeout_at > now)
        throw new ExecutionJobDeferredError(pause.timeout_at);
      await trx
        .updateTable("workflow_pauses")
        .set({ status: "timed_out", resolved_at: now })
        .where("id", "=", pause.id)
        .execute();
      await this.resolvePause({ trx, pause, reason: "timed_out" });
    });
  }

  async suspendForChild(args: {
    workflowStepAttemptId: string;
    job: ExecutionJob;
    child: {
      workflowName: string;
      capabilities: WorkflowCapabilities;
      execution: WorkflowExecutionDescriptor;
      input: Json;
    };
  }): Promise<string | null> {
    return this.db.transaction().execute(async (trx) => {
      const context = await this.lockActiveAttempt({
        trx,
        workflowStepAttemptId: args.workflowStepAttemptId,
      });
      if (
        context?.run.status !== "running" ||
        context?.attempt.status !== "running" ||
        !(await ownsJob({ trx, job: args.job }))
      ) {
        return null;
      }
      const parent = context.run;
      if (!parent.deployment_artifact_id) {
        throw new Error("A child workflow requires a deployment artifact");
      }
      const now = await databaseNow(trx);
      const childRunId = crypto.randomUUID();
      const firstStep = args.child.execution.steps[0];
      await trx
        .insertInto("workflow_runs")
        .values({
          id: childRunId,
          project_id: parent.project_id,
          workflow_name: args.child.workflowName,
          mode: "production",
          provenance: jsonColumn(
            toJson({
              ...jsonRecord(parent.provenance),
              capabilities: args.child.capabilities,
            }),
          ),
          deployment_artifact_id: parent.deployment_artifact_id,
          external_user_id: parent.external_user_id,
          status: "pending",
          phase: firstStep ? phaseFor(firstStep) : "execute",
          input: jsonColumn(args.child.input),
          parent_run_id: parent.id,
          parent_workflow_step_attempt_id: context.attempt.id,
        })
        .execute();
      await trx
        .updateTable("workflow_step_attempts")
        .set({ status: "waiting", updated_at: now })
        .where("id", "=", context.attempt.id)
        .execute();
      await trx
        .updateTable("workflow_runs")
        .set({ status: "waiting", phase: "child", updated_at: now })
        .where("id", "=", parent.id)
        .where("status", "in", [...ACTIVE_RUN_STATUSES])
        .execute();
      if (firstStep) {
        await this.initialize({
          trx,
          tenantId: context.tenantId,
          runId: childRunId,
          execution: args.child.execution,
          input: args.child.input,
        });
      } else {
        await this.jobs.enqueue({
          trx,
          tenantId: context.tenantId,
          workflowRunId: childRunId,
          kind: "workflow_run",
          payload: {},
          priority: 100,
          dedupeKey: `run:${childRunId}:execute`,
        });
      }
      return childRunId;
    });
  }

  async beginPlainRun(args: { job: ExecutionJob }): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      const run = await lockRun({ trx, runId: args.job.workflowRunId });
      if (!run || !(await ownsJob({ trx, job: args.job }))) return false;
      if (isTerminalRunStatus(run.status)) {
        await this.reconcileParentFromTerminalChild({
          trx,
          childRunId: run.id,
        });
        return false;
      }
      if (!isActiveRunStatus(run.status)) return false;
      const now = await databaseNow(trx);
      const updated = await trx
        .updateTable("workflow_runs")
        .set({
          status: "running",
          phase: "execute",
          started_at: run.started_at ?? now,
          attempt: args.job.attempt,
          updated_at: now,
        })
        .where("id", "=", run.id)
        .where("status", "in", [...ACTIVE_RUN_STATUSES])
        .returning("id")
        .executeTakeFirst();
      return updated !== undefined;
    });
  }

  async finalizePlainRun(args: {
    job: ExecutionJob;
    result: RunResult;
  }): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      const run = await lockRun({ trx, runId: args.job.workflowRunId });
      if (!run || !(await ownsJob({ trx, job: args.job }))) return false;
      if (isTerminalRunStatus(run.status)) {
        await this.reconcileParentFromTerminalChild({
          trx,
          childRunId: run.id,
        });
        return false;
      }
      if (!isActiveRunStatus(run.status)) return false;
      const now = await databaseNow(trx);
      const updated = await trx
        .updateTable("workflow_runs")
        .set({
          status: args.result.status,
          result: jsonColumn(toJson(args.result.result)),
          error: args.result.error ?? null,
          completed_at: now,
          updated_at: now,
        })
        .where("id", "=", run.id)
        .where("status", "in", [...ACTIVE_RUN_STATUSES])
        .returning("id")
        .executeTakeFirst();
      if (!updated) return false;
      if (args.result.steps.length > 0) {
        await trx
          .insertInto("workflow_run_steps")
          .values(
            args.result.steps.map((step) => ({
              id: crypto.randomUUID(),
              run_id: run.id,
              node_id: step.nodeId,
              occurrence: step.occurrence ?? 0,
              name: step.name,
              status: step.status,
              attempt: step.attempt ?? 1,
              input: jsonColumn(toJson(step.input)),
              output: jsonColumn(toJson(step.output)),
              error: step.error ?? null,
              started_at: new Date(step.startedAt),
              completed_at: new Date(step.completedAt),
            })),
          )
          .onConflict((conflict) =>
            conflict.columns(["run_id", "node_id", "occurrence"]).doNothing(),
          )
          .execute();
      }
      await this.finishParent({
        trx,
        childRunId: run.id,
        ...(args.result.status === "completed"
          ? { output: toJson(args.result.result) }
          : { error: args.result.error ?? "Plain child workflow failed" }),
      });
      return true;
    });
  }

  async reconcileTerminalChild(args: { job: ExecutionJob }): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      if (!(await ownsJob({ trx, job: args.job }))) return;
      await this.reconcileParentFromTerminalChild({
        trx,
        childRunId: args.job.workflowRunId,
      });
    });
  }

  async pauseOperator(args: {
    identity: Identity;
    runId: string;
  }): Promise<"paused" | "already-paused" | "unavailable"> {
    return this.db.transaction().execute(async (trx) => {
      await requireOwnedRun({
        trx,
        identity: args.identity,
        runId: args.runId,
      });
      const run = await lockRun({ trx, runId: args.runId });
      if (!run) return "unavailable";
      const activeAttempt = await trx
        .selectFrom("workflow_run_states")
        .innerJoin(
          "workflow_step_attempts",
          "workflow_step_attempts.id",
          "workflow_run_states.active_workflow_step_attempt_id",
        )
        .where("workflow_run_states.run_id", "=", args.runId)
        .where("workflow_step_attempts.executor", "=", "batch")
        .select([
          "workflow_step_attempts.id",
          "workflow_run_states.operator_pause_previous_status",
        ])
        .executeTakeFirst();
      if (run.status === "paused") {
        return activeAttempt?.operator_pause_previous_status
          ? "already-paused"
          : "unavailable";
      }
      if (
        !isActiveRunStatus(run.status) ||
        !["source", "process", "sink"].includes(run.phase) ||
        !activeAttempt ||
        activeAttempt.operator_pause_previous_status !== null
      ) {
        return "unavailable";
      }
      const now = await databaseNow(trx);
      await trx
        .updateTable("workflow_run_states")
        .set({
          operator_pause_previous_status: run.status,
          operator_pause_previous_phase: run.phase,
          updated_at: now,
        })
        .where("run_id", "=", args.runId)
        .where("operator_pause_previous_status", "is", null)
        .execute();
      await trx
        .updateTable("workflow_runs")
        .set({ status: "paused", updated_at: now })
        .where("id", "=", args.runId)
        .where("status", "in", [...ACTIVE_RUN_STATUSES])
        .execute();
      return "paused";
    });
  }

  async resumeOperator(args: {
    identity: Identity;
    runId: string;
  }): Promise<"resumed" | "already-running" | "unavailable"> {
    return this.db.transaction().execute(async (trx) => {
      await requireOwnedRun({
        trx,
        identity: args.identity,
        runId: args.runId,
      });
      const run = await lockRun({ trx, runId: args.runId });
      if (!run) return "unavailable";
      const state = await trx
        .selectFrom("workflow_run_states")
        .innerJoin(
          "workflow_step_attempts",
          "workflow_step_attempts.id",
          "workflow_run_states.active_workflow_step_attempt_id",
        )
        .where("workflow_run_states.run_id", "=", args.runId)
        .where("workflow_step_attempts.executor", "=", "batch")
        .select([
          "workflow_run_states.operator_pause_previous_status",
          "workflow_run_states.operator_pause_previous_phase",
        ])
        .forUpdate()
        .executeTakeFirst();
      if (!state) return "unavailable";
      if (run.status !== "paused") {
        return run.status === "running" &&
          ["source", "process", "sink"].includes(run.phase) &&
          state.operator_pause_previous_status === null
          ? "already-running"
          : "unavailable";
      }
      if (state.operator_pause_previous_status === null) return "unavailable";
      const now = await databaseNow(trx);
      await trx
        .updateTable("workflow_runs")
        .set({
          status: state.operator_pause_previous_status ?? "running",
          phase: state.operator_pause_previous_phase ?? "process",
          updated_at: now,
        })
        .where("id", "=", args.runId)
        .where("status", "=", "paused")
        .execute();
      await trx
        .updateTable("workflow_run_states")
        .set({
          operator_pause_previous_status: null,
          operator_pause_previous_phase: null,
          updated_at: now,
        })
        .where("run_id", "=", args.runId)
        .execute();
      // Jobs deferred while this run was paused are parked an hour out rather
      // than polling for it. Pull them forward in the same transaction, so a
      // resume that commits always leaves its work runnable.
      await trx
        .updateTable("execution_jobs")
        .set({ available_at: now, updated_at: now })
        .where("workflow_run_id", "=", args.runId)
        .where("status", "=", "pending")
        .where("available_at", ">", now)
        .execute();
      return "resumed";
    });
  }

  async cancel(args: {
    identity: Identity;
    runId: string;
    reason?: string;
  }): Promise<Array<{ artifactId: string; invocationId: string }>> {
    const outcome = await this.db.transaction().execute(async (trx) => {
      await requireOwnedRun({
        trx,
        identity: args.identity,
        runId: args.runId,
      });
      const root = await lockRun({ trx, runId: args.runId });
      if (!root) throw new Error(`Run '${args.runId}' not found`);
      const runs = await lockRunHierarchy({ trx, root });
      const runIds = runs.map((run) => run.id);
      const invocations = await trx
        .selectFrom("active_run_invocations")
        .where("workflow_run_id", "in", runIds)
        .select(["workflow_run_id", "invocation_id"])
        .orderBy("created_at")
        .execute();
      const active = runs.filter((run) => !isTerminalRunStatus(run.status));
      if (active.length === 0) {
        return {
          invocations: [],
          reconcileChildRunId: root.parent_run_id ? root.id : null,
        };
      }
      const activeIds = active.map((run) => run.id);
      const now = await databaseNow(trx);
      await trx
        .updateTable("workflow_runs")
        .set({
          status: "canceling",
          cancel_requested_at: now,
          cancel_reason: args.reason ?? null,
          updated_at: now,
        })
        .where("id", "in", activeIds)
        .execute();
      await trx
        .updateTable("workflow_step_attempts")
        .set({ status: "canceled", completed_at: now, updated_at: now })
        .where("run_id", "in", activeIds)
        .where("status", "in", ["pending", "running", "waiting"])
        .execute();
      await trx
        .updateTable("workflow_pauses")
        .set({ status: "canceled", resolved_at: now })
        .where("run_id", "in", activeIds)
        .where("status", "=", "open")
        .execute();
      await trx
        .updateTable("batch_items")
        .set({ status: "canceled", completed_at: now, updated_at: now })
        .where("run_id", "in", activeIds)
        .where("status", "in", ["pending", "running", "waiting"])
        .execute();
      await trx
        .updateTable("batch_step_invocations")
        .set({ status: "canceled", completed_at: now, updated_at: now })
        .where("run_id", "in", activeIds)
        .where("status", "in", ["pending", "running"])
        .execute();
      await trx
        .updateTable("execution_jobs")
        .set({
          status: "canceled",
          leased_by: null,
          lease_token: null,
          heartbeat_at: null,
          lease_expires_at: null,
          completed_at: now,
          updated_at: now,
        })
        .where("workflow_run_id", "in", activeIds)
        .where("status", "in", ["pending", "running"])
        .execute();
      await trx
        .deleteFrom("active_run_invocations")
        .where("workflow_run_id", "in", activeIds)
        .execute();
      await trx
        .updateTable("workflow_runs")
        .set({ status: "canceled", completed_at: now, updated_at: now })
        .where("id", "in", activeIds)
        .where("status", "=", "canceling")
        .execute();
      const artifacts = new Map(
        active.flatMap((run) =>
          run.deployment_artifact_id
            ? [[run.id, run.deployment_artifact_id] as const]
            : [],
        ),
      );
      return {
        invocations: invocations.flatMap((invocation) => {
          const artifactId = artifacts.get(invocation.workflow_run_id);
          return artifactId
            ? [
                {
                  artifactId,
                  invocationId: invocation.invocation_id,
                },
              ]
            : [];
        }),
        reconcileChildRunId:
          root.parent_run_id && !runIds.includes(root.parent_run_id)
            ? root.id
            : null,
      };
    });
    if (outcome.reconcileChildRunId) {
      await this.db.transaction().execute((trx) =>
        this.reconcileParentFromTerminalChild({
          trx,
          childRunId: outcome.reconcileChildRunId ?? "",
        }),
      );
    }
    return outcome.invocations;
  }

  async handleExhaustedJob(args: {
    job: ExecutionJob;
    error: string;
  }): Promise<void> {
    if (args.job.workflowStepAttemptId) {
      await this.failStep({
        workflowStepAttemptId: args.job.workflowStepAttemptId,
        error: args.error,
        allowBoundaryRetry: args.job.kind !== "durable_boundary",
      });
      return;
    }
    await this.db.transaction().execute(async (trx) => {
      const run = await lockRun({ trx, runId: args.job.workflowRunId });
      if (!run) return;
      if (isTerminalRunStatus(run.status)) {
        await this.reconcileParentFromTerminalChild({
          trx,
          childRunId: run.id,
        });
        return;
      }
      if (!isActiveRunStatus(run.status)) return;
      await this.failRun({
        trx,
        runId: args.job.workflowRunId,
        error: args.error,
        now: await databaseNow(trx),
      });
    });
  }

  private async createStepAttempt(args: {
    trx: Transaction<DB>;
    tenantId: string;
    runId: string;
    descriptor: WorkflowExecutionUnitDescriptor;
    input: Json;
    attempt: number;
    availableAt?: Date;
  }): Promise<string> {
    const id = crypto.randomUUID();
    const policy =
      args.descriptor.type === "boundary"
        ? boundaryPolicy(args.descriptor)
        : batchPolicy(args.descriptor);
    await args.trx
      .insertInto("workflow_step_attempts")
      .values({
        id,
        run_id: args.runId,
        step_index: args.descriptor.topLevelIndex,
        step_node_id: args.descriptor.nodeId,
        executor: args.descriptor.type,
        attempt: args.attempt,
        input: jsonColumn(args.input),
        policy,
      })
      .execute();
    if (args.descriptor.type === "batch") {
      await args.trx
        .insertInto("batch_execution_states")
        .values({
          run_id: args.runId,
          workflow_step_attempt_id: id,
          failure_policy: policy,
        })
        .execute();
    }
    await args.trx
      .updateTable("workflow_run_states")
      .set({
        current_step_index: args.descriptor.topLevelIndex,
        current_input: jsonColumn(args.input),
        active_workflow_step_attempt_id: id,
        updated_at: await databaseNow(args.trx),
      })
      .where("run_id", "=", args.runId)
      .execute();
    await args.trx
      .updateTable("workflow_runs")
      .set({
        status: "pending",
        phase: phaseFor(args.descriptor),
        updated_at: await databaseNow(args.trx),
      })
      .where("id", "=", args.runId)
      .where("status", "in", [...ACTIVE_RUN_STATUSES])
      .execute();
    const kind =
      args.descriptor.type === "boundary" ? "durable_boundary" : "batch_source";
    await this.jobs.enqueue({
      trx: args.trx,
      tenantId: args.tenantId,
      workflowRunId: args.runId,
      workflowStepAttemptId: id,
      kind,
      payload:
        args.descriptor.type === "boundary"
          ? { operation: "run" }
          : { operation: "initialize" },
      availableAt: args.availableAt,
      maxAttempts: 10,
      dedupeKey: `run:${args.runId}:step:${args.descriptor.topLevelIndex}:attempt:${args.attempt}:${kind}`,
    });
    return id;
  }

  private async advance(args: {
    trx: Transaction<DB>;
    tenantId: string;
    runId: string;
    completedStepIndex: number;
    output: Json;
  }): Promise<void> {
    const run = await lockRun({ trx: args.trx, runId: args.runId });
    if (!run || !isActiveRunStatus(run.status)) return;
    const state = await args.trx
      .selectFrom("workflow_run_states")
      .where("run_id", "=", args.runId)
      .selectAll()
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (state.current_step_index !== args.completedStepIndex) return;
    const steps = executionSteps(state.execution_plan);
    const next = steps[args.completedStepIndex + 1];
    if (!next) {
      const now = await databaseNow(args.trx);
      await args.trx
        .updateTable("workflow_run_states")
        .set({
          current_input: jsonColumn(args.output),
          active_workflow_step_attempt_id: null,
          updated_at: now,
        })
        .where("run_id", "=", args.runId)
        .execute();
      const completed = await args.trx
        .updateTable("workflow_runs")
        .set({
          status: "completed",
          result: jsonColumn(args.output),
          error: null,
          completed_at: now,
          updated_at: now,
        })
        .where("id", "=", args.runId)
        .where("status", "in", [...ACTIVE_RUN_STATUSES])
        .returning("id")
        .executeTakeFirst();
      if (completed) {
        await this.finishParent({
          trx: args.trx,
          childRunId: args.runId,
          output: args.output,
        });
      }
      return;
    }
    await this.createStepAttempt({
      trx: args.trx,
      tenantId: args.tenantId,
      runId: args.runId,
      descriptor: next,
      input: args.output,
      attempt: 1,
    });
  }

  private async failRun(args: {
    trx: Transaction<DB>;
    runId: string;
    error: string;
    now: Date;
    excludeJobId?: string;
  }): Promise<void> {
    await this.cleanupRunScope(args);
    const failed = await args.trx
      .updateTable("workflow_runs")
      .set({
        status: "failed",
        error: args.error,
        completed_at: args.now,
        updated_at: args.now,
      })
      .where("id", "=", args.runId)
      .where("status", "in", [...ACTIVE_RUN_STATUSES])
      .returning("id")
      .executeTakeFirst();
    if (failed) {
      await this.finishParent({
        trx: args.trx,
        childRunId: args.runId,
        error: args.error,
      });
    }
  }

  private async finishParent(args: {
    trx: Transaction<DB>;
    childRunId: string;
    output?: Json;
    error?: string;
  }): Promise<void> {
    const child = await args.trx
      .selectFrom("workflow_runs")
      .where("id", "=", args.childRunId)
      .select(["parent_run_id", "parent_workflow_step_attempt_id"])
      .executeTakeFirst();
    if (!child?.parent_run_id || !child.parent_workflow_step_attempt_id) return;
    const context = await this.lockActiveAttempt({
      trx: args.trx,
      workflowStepAttemptId: child.parent_workflow_step_attempt_id,
    });
    if (context?.attempt.status !== "waiting") return;
    if (args.error) {
      const now = await databaseNow(args.trx);
      await this.cleanupStepScope({
        trx: args.trx,
        runId: context.attempt.run_id,
        workflowStepAttemptId: context.attempt.id,
        error: args.error,
        now,
      });
      await args.trx
        .updateTable("workflow_step_attempts")
        .set({
          status: "failed",
          error: args.error,
          completed_at: now,
          updated_at: now,
        })
        .where("id", "=", context.attempt.id)
        .execute();
      const policy = jsonRecord(context.attempt.policy);
      const maxAttempts = finiteInteger(policy.maxAttempts) ?? 1;
      if (
        context.attempt.executor === "boundary" &&
        context.attempt.attempt < maxAttempts
      ) {
        const descriptor = executionSteps(context.state.execution_plan)[
          context.attempt.step_index
        ];
        if (!descriptor) throw new Error("Parent workflow step is missing");
        await this.createStepAttempt({
          trx: args.trx,
          tenantId: context.tenantId,
          runId: context.attempt.run_id,
          descriptor,
          input: context.attempt.input,
          attempt: context.attempt.attempt + 1,
          availableAt: retryAt({
            policy,
            attempt: context.attempt.attempt,
            now,
          }),
        });
        return;
      }
      await this.failRun({
        trx: args.trx,
        runId: child.parent_run_id,
        error: args.error,
        now,
      });
      return;
    }
    const now = await databaseNow(args.trx);
    const output = args.output ?? null;
    await args.trx
      .updateTable("workflow_step_attempts")
      .set({
        status: "completed",
        output: jsonColumn(output),
        completed_at: now,
        updated_at: now,
      })
      .where("id", "=", context.attempt.id)
      .execute();
    await this.advance({
      trx: args.trx,
      tenantId: context.tenantId,
      runId: child.parent_run_id,
      completedStepIndex: context.attempt.step_index,
      output,
    });
  }

  private async reconcileParentFromTerminalChild(args: {
    trx: Transaction<DB>;
    childRunId: string;
  }): Promise<void> {
    const child = await args.trx
      .selectFrom("workflow_runs")
      .where("id", "=", args.childRunId)
      .select(["status", "result", "error", "cancel_reason"])
      .executeTakeFirst();
    if (!child || !isTerminalRunStatus(child.status)) return;
    await this.finishParent({
      trx: args.trx,
      childRunId: args.childRunId,
      ...(child.status === "completed"
        ? { output: child.result ?? null }
        : {
            error:
              child.error ??
              child.cancel_reason ??
              `Child workflow ${child.status}`,
          }),
    });
  }

  private async cleanupStepScope(args: {
    trx: Transaction<DB>;
    runId: string;
    workflowStepAttemptId: string;
    error: string;
    now: Date;
    excludeJobId?: string;
  }): Promise<void> {
    await args.trx
      .deleteFrom("active_run_invocations")
      .where("workflow_run_id", "=", args.runId)
      .where("workflow_step_attempt_id", "=", args.workflowStepAttemptId)
      .execute();
    await args.trx
      .updateTable("execution_jobs")
      .set({
        status: "canceled",
        leased_by: null,
        lease_token: null,
        heartbeat_at: null,
        lease_expires_at: null,
        completed_at: args.now,
        updated_at: args.now,
      })
      .where("workflow_run_id", "=", args.runId)
      .where("workflow_step_attempt_id", "=", args.workflowStepAttemptId)
      .$if(args.excludeJobId !== undefined, (query) =>
        query.where("id", "!=", args.excludeJobId ?? ""),
      )
      .where("status", "in", ["pending", "running"])
      .execute();
    await args.trx
      .updateTable("workflow_pauses")
      .set({ status: "canceled", resolved_at: args.now })
      .where("run_id", "=", args.runId)
      .where("workflow_step_attempt_id", "=", args.workflowStepAttemptId)
      .where("status", "=", "open")
      .execute();
    await args.trx
      .updateTable("batch_items")
      .set({
        status: "canceled",
        error: args.error,
        completed_at: args.now,
        updated_at: args.now,
      })
      .where("run_id", "=", args.runId)
      .where("workflow_step_attempt_id", "=", args.workflowStepAttemptId)
      .where("status", "in", ["pending", "running", "waiting"])
      .execute();
    await args.trx
      .updateTable("batch_step_invocations")
      .set({
        status: "canceled",
        error: args.error,
        completed_at: args.now,
        updated_at: args.now,
      })
      .where("run_id", "=", args.runId)
      .where("workflow_step_attempt_id", "=", args.workflowStepAttemptId)
      .where("status", "in", ["pending", "running"])
      .execute();
    await args.trx
      .updateTable("batch_step_members")
      .set({ status: "unresolved", error: args.error, completed_at: args.now })
      .where("run_id", "=", args.runId)
      .where("workflow_step_attempt_id", "=", args.workflowStepAttemptId)
      .where("status", "=", "pending")
      .execute();
    await args.trx
      .updateTable("batch_item_steps")
      .set({
        status: "failed",
        error: args.error,
        completed_at: args.now,
        updated_at: args.now,
      })
      .where("run_id", "=", args.runId)
      .where("workflow_step_attempt_id", "=", args.workflowStepAttemptId)
      .where("status", "in", ["pending", "running", "waiting"])
      .execute();
    await args.trx
      .updateTable("batch_sink_chunks")
      .set({
        status: "failed",
        error: args.error,
        completed_at: args.now,
        updated_at: args.now,
      })
      .where("run_id", "=", args.runId)
      .where("workflow_step_attempt_id", "=", args.workflowStepAttemptId)
      .where("status", "in", ["pending", "running"])
      .execute();
  }

  private async cleanupRunScope(args: {
    trx: Transaction<DB>;
    runId: string;
    error: string;
    now: Date;
    excludeJobId?: string;
  }): Promise<void> {
    const attempts = await args.trx
      .selectFrom("workflow_step_attempts")
      .where("run_id", "=", args.runId)
      .where("status", "in", ["pending", "running", "waiting"])
      .select("id")
      .execute();
    for (const attempt of attempts) {
      await this.cleanupStepScope({
        ...args,
        workflowStepAttemptId: attempt.id,
      });
    }
    await args.trx
      .updateTable("workflow_step_attempts")
      .set({
        status: "failed",
        error: args.error,
        completed_at: args.now,
        updated_at: args.now,
      })
      .where("run_id", "=", args.runId)
      .where("status", "in", ["pending", "running", "waiting"])
      .execute();
    await args.trx
      .updateTable("workflow_run_states")
      .set({
        operator_pause_previous_status: null,
        operator_pause_previous_phase: null,
        updated_at: args.now,
      })
      .where("run_id", "=", args.runId)
      .execute();
    await args.trx
      .deleteFrom("active_run_invocations")
      .where("workflow_run_id", "=", args.runId)
      .execute();
    await args.trx
      .updateTable("execution_jobs")
      .set({
        status: "canceled",
        leased_by: null,
        lease_token: null,
        heartbeat_at: null,
        lease_expires_at: null,
        completed_at: args.now,
        updated_at: args.now,
      })
      .where("workflow_run_id", "=", args.runId)
      .$if(args.excludeJobId !== undefined, (query) =>
        query.where("id", "!=", args.excludeJobId ?? ""),
      )
      .where("status", "in", ["pending", "running"])
      .execute();
  }

  private async resolvePause(args: {
    trx: Transaction<DB>;
    pause: {
      run_id: string;
      workflow_step_attempt_id: string;
      state_present: boolean;
      state: Json | null;
      resume_value: Json | null;
    };
    reason: "resumed" | "timed_out";
  }): Promise<void> {
    const context = await this.lockActiveAttempt({
      trx: args.trx,
      workflowStepAttemptId: args.pause.workflow_step_attempt_id,
    });
    if (context?.attempt.status !== "waiting") return;
    const output = toJson({
      reason: args.reason,
      ...(args.reason === "resumed" ? { value: args.pause.resume_value } : {}),
      ...(args.pause.state_present ? { state: args.pause.state } : {}),
    });
    const now = await databaseNow(args.trx);
    await args.trx
      .updateTable("workflow_step_attempts")
      .set({
        status: "completed",
        output: jsonColumn(output),
        completed_at: now,
        updated_at: now,
      })
      .where("id", "=", context.attempt.id)
      .execute();
    await this.advance({
      trx: args.trx,
      tenantId: context.tenantId,
      runId: args.pause.run_id,
      completedStepIndex: context.attempt.step_index,
      output,
    });
  }

  private async lockActiveAttempt(args: {
    trx: Transaction<DB>;
    workflowStepAttemptId: string;
  }) {
    const attemptRun = await args.trx
      .selectFrom("workflow_step_attempts")
      .where("id", "=", args.workflowStepAttemptId)
      .select("run_id")
      .executeTakeFirst();
    if (!attemptRun) return null;
    const run = await lockRun({ trx: args.trx, runId: attemptRun.run_id });
    if (!run || !isActiveRunStatus(run.status)) return null;
    const attempt = await args.trx
      .selectFrom("workflow_step_attempts")
      .where("id", "=", args.workflowStepAttemptId)
      .selectAll()
      .forUpdate()
      .executeTakeFirst();
    if (!attempt) return null;
    const state = await args.trx
      .selectFrom("workflow_run_states")
      .where("run_id", "=", attempt.run_id)
      .where("active_workflow_step_attempt_id", "=", attempt.id)
      .selectAll()
      .forUpdate()
      .executeTakeFirst();
    if (!state) return null;
    const tenantId = await tenantForRun({
      trx: args.trx,
      runId: attempt.run_id,
    });
    return { attempt, state, run, tenantId };
  }

  private async registerInvocation(args: {
    job: ExecutionJob;
    invocationId: string;
  }): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      const run = await shareLockRun({ trx, runId: args.job.workflowRunId });
      if (!run || !isActiveRunStatus(run.status)) return false;
      if (!(await ownsJob({ trx, job: args.job }))) return false;
      const inserted = await trx
        .insertInto("active_run_invocations")
        .values({
          invocation_id: args.invocationId,
          workflow_run_id: args.job.workflowRunId,
          workflow_step_attempt_id: args.job.workflowStepAttemptId,
          execution_job_id: args.job.id,
          lease_token: requireJobLeaseToken(args.job),
          lease_generation: args.job.leaseGeneration,
        })
        .onConflict((conflict) => conflict.column("invocation_id").doNothing())
        .returning("invocation_id")
        .executeTakeFirst();
      return inserted !== undefined;
    });
  }

  private async unregisterInvocation(args: {
    job: ExecutionJob;
    invocationId: string;
  }): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      const run = await shareLockRun({ trx, runId: args.job.workflowRunId });
      if (!run || !isActiveRunStatus(run.status)) return false;
      if (!(await ownsJob({ trx, job: args.job }))) return false;
      const deleted = await trx
        .deleteFrom("active_run_invocations")
        .where("invocation_id", "=", args.invocationId)
        .where("execution_job_id", "=", args.job.id)
        .where("lease_token", "=", requireJobLeaseToken(args.job))
        .where("lease_generation", "=", args.job.leaseGeneration)
        .returning("invocation_id")
        .executeTakeFirst();
      return deleted !== undefined;
    });
  }
}

export class RuntimeInvocationFencedError extends Error {
  constructor(readonly invocationId: string) {
    super(`Runtime invocation '${invocationId}' lost its execution lease`);
    this.name = "RuntimeInvocationFencedError";
  }
}

export class RunPauseNotFoundError extends Error {
  constructor(readonly pauseId: string) {
    super(`Run pause '${pauseId}' not found`);
    this.name = "RunPauseNotFoundError";
  }
}

export class RunResumeConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunResumeConflictError";
  }
}

export async function ownsJob(args: {
  trx: Transaction<DB>;
  job: ExecutionJob;
}): Promise<boolean> {
  if (!args.job.leaseToken) return false;
  const row = await args.trx
    .selectFrom("execution_jobs")
    .where("id", "=", args.job.id)
    .where("status", "=", "running")
    .where("leased_by", "=", args.job.leasedBy)
    .where("lease_token", "=", args.job.leaseToken)
    .where("lease_generation", "=", args.job.leaseGeneration)
    .where("lease_expires_at", ">", sql<Date>`clock_timestamp()`)
    .select("id")
    .forUpdate()
    .executeTakeFirst();
  return row !== undefined;
}

export async function databaseNow(trx: Transaction<DB>): Promise<Date> {
  const result = await sql<{
    now: Date;
  }>`SELECT clock_timestamp() AS now`.execute(trx);
  const now = result.rows[0]?.now;
  if (!now) throw new Error("Database did not return the current time");
  return now;
}

export function toJson(value: unknown): Json {
  return JSON.parse(JSON.stringify(value ?? null)) as Json;
}

export function jsonColumn(value: Json) {
  return sql<Json>`${JSON.stringify(value)}::jsonb`;
}

export function jsonRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function executionSteps(value: Json): WorkflowExecutionUnitDescriptor[] {
  const steps = jsonRecord(value).steps;
  if (!Array.isArray(steps))
    throw new Error("Workflow execution plan is invalid");
  return steps.map((step) => {
    const descriptor = jsonRecord(step);
    if (
      (descriptor.type !== "boundary" && descriptor.type !== "batch") ||
      typeof descriptor.topLevelIndex !== "number" ||
      typeof descriptor.nodeId !== "string"
    ) {
      throw new Error("Workflow execution step is invalid");
    }
    return descriptor as unknown as WorkflowExecutionUnitDescriptor;
  });
}

function boundaryPolicy(unit: unknown): Json {
  const descriptor = jsonRecord(jsonRecord(unit).retry);
  const backoff = jsonRecord(descriptor.backoff);
  const rateLimits = boundaryRateLimits(jsonRecord(unit).rateLimits);
  return toJson({
    maxAttempts: expressionNumber(descriptor.maxAttemptsExpression) ?? 1,
    initial: expressionString(backoff.initialExpression) ?? null,
    maximum: expressionString(backoff.maximumExpression) ?? null,
    multiplier: expressionNumber(backoff.multiplierExpression) ?? 2,
    ...(rateLimits.length > 0 ? { rateLimits } : {}),
  });
}

function boundaryRateLimits(value: unknown): Json[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const limit = jsonRecord(entry);
    const globalKey = expressionString(limit.globalKeyExpression);
    const capacity = expressionNumber(limit.capacityExpression);
    const refillRatePerSecond = expressionNumber(
      limit.refillRatePerSecondExpression,
    );
    if (!globalKey || !capacity || !refillRatePerSecond) return [];
    const partitionKey = expressionString(limit.partitionKeyExpression);
    const cost = expressionNumber(limit.costExpression);
    return [
      toJson({
        globalKey,
        ...(partitionKey ? { partitionKey } : {}),
        capacity,
        refillRatePerSecond,
        ...(cost ? { cost } : {}),
      }),
    ];
  });
}

function batchPolicy(descriptor: unknown): Json {
  const policy = jsonRecord(jsonRecord(descriptor).failurePolicy);
  const mode =
    expressionString(policy.modeExpression) ?? stringValue(policy.mode);
  const maxFailures =
    expressionNumber(policy.maxFailuresExpression) ??
    finiteInteger(policy.maxFailures);
  return toJson({
    mode: mode === "fail_fast" ? "fail_fast" : "continue",
    ...(maxFailures ? { maxFailures } : {}),
  });
}

function expressionNumber(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Number(value.replaceAll("_", "").trim());
  return Number.isFinite(parsed) ? parsed : undefined;
}

function expressionString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith("`") && trimmed.endsWith("`"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed || undefined;
}

function finiteInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

function retryAt(args: {
  policy: Record<string, unknown>;
  attempt: number;
  now: Date;
}): Date {
  const initial =
    typeof args.policy.initial === "string"
      ? parseDuration(args.policy.initial)
      : 1_000;
  const multiplier =
    typeof args.policy.multiplier === "number" ? args.policy.multiplier : 2;
  const maximum =
    typeof args.policy.maximum === "string"
      ? parseDuration(args.policy.maximum)
      : Number.POSITIVE_INFINITY;
  return new Date(
    args.now.getTime() +
      Math.min(maximum, initial * multiplier ** (args.attempt - 1)),
  );
}

function parseDuration(raw: string): number {
  const value = raw.replaceAll('"', "").trim();
  const match = value.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/i);
  if (!match) throw new Error(`Unsupported duration '${raw}'`);
  const amount = Number(match[1]);
  const unit = match[2]?.toLowerCase() ?? "ms";
  return (
    amount *
    ({ ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit] ?? 1)
  );
}

function phaseFor(
  descriptor: WorkflowExecutionUnitDescriptor,
): "boundary" | "source" {
  return descriptor.type === "boundary" ? "boundary" : "source";
}

function lockRun(args: { trx: Transaction<DB>; runId: string }) {
  return args.trx
    .selectFrom("workflow_runs")
    .where("id", "=", args.runId)
    .selectAll()
    .forUpdate()
    .executeTakeFirst();
}

/**
 * Pins a run's status without excluding other readers.
 *
 * Callers that only need the run to stay non-terminal for the length of their
 * transaction — invocation fencing, not run mutation — would otherwise take
 * `FOR UPDATE` and serialize every concurrent item of a batch against the one
 * `workflow_runs` row. `FOR SHARE` still blocks the canceler's `FOR UPDATE`,
 * so the fence holds, while items no longer block each other.
 */
function shareLockRun(args: { trx: Transaction<DB>; runId: string }) {
  return args.trx
    .selectFrom("workflow_runs")
    .where("id", "=", args.runId)
    .selectAll()
    .forShare()
    .executeTakeFirst();
}

async function tenantForRun(args: {
  trx: Transaction<DB>;
  runId: string;
}): Promise<string> {
  return args.trx
    .selectFrom("workflow_runs")
    .innerJoin("projects", "projects.id", "workflow_runs.project_id")
    .where("workflow_runs.id", "=", args.runId)
    .select("projects.tenant_id")
    .executeTakeFirstOrThrow()
    .then((row) => row.tenant_id);
}

async function requireOwnedRun(args: {
  trx: Transaction<DB>;
  identity: Identity;
  runId: string;
}): Promise<void> {
  const row = await args.trx
    .selectFrom("workflow_runs")
    .innerJoin("projects", "projects.id", "workflow_runs.project_id")
    .where("workflow_runs.id", "=", args.runId)
    .where("projects.tenant_id", "=", args.identity.tenantId)
    .select("workflow_runs.id")
    .executeTakeFirst();
  if (!row) throw new Error(`Run '${args.runId}' not found`);
}

async function lockRunHierarchy(args: {
  trx: Transaction<DB>;
  root: Awaited<ReturnType<typeof lockRun>> & {};
}) {
  const runs = [args.root];
  for (let index = 0; index < runs.length; index += 1) {
    const parent = runs[index];
    if (!parent) continue;
    const children = await args.trx
      .selectFrom("workflow_runs")
      .where("parent_run_id", "=", parent.id)
      .selectAll()
      .orderBy("id")
      .forUpdate()
      .execute();
    for (const child of children) {
      if (!runs.some((run) => run.id === child.id)) runs.push(child);
    }
  }
  return runs;
}

function requireJobLeaseToken(job: ExecutionJob): string {
  if (!job.leaseToken)
    throw new Error(`Execution job '${job.id}' has no lease token`);
  return job.leaseToken;
}

function isActiveRunStatus(status: string): boolean {
  return ACTIVE_RUN_STATUSES.includes(
    status as (typeof ACTIVE_RUN_STATUSES)[number],
  );
}

function isTerminalRunStatus(status: string): boolean {
  return TERMINAL_RUN_STATUSES.includes(
    status as (typeof TERMINAL_RUN_STATUSES)[number],
  );
}
