import type { DB, Json } from "@catamorphic/db";
import type {
  WorkflowCapabilities,
  WorkflowExecutionDescriptor,
} from "@catamorphic/parser";
import type { RuntimeInvocationReceipt } from "@catamorphic/sandbox";
import type { Kysely } from "kysely";
import type { Identity } from "../identity.js";
import type { ExecutionJob } from "./execution-jobs-service.js";
import {
  ExecutionJobDeferredError,
  type ExecutionWorkerService,
} from "./execution-worker-service.js";
import type {
  RateBucketKey,
  RateLimit,
  RateReservationsService,
} from "./rate-reservations-service.js";
import {
  jsonColumn,
  jsonRecord,
  type RunCoordinator,
  stringValue,
  toJson,
} from "./run-coordinator.js";
import type { TenantPoliciesService } from "./tenant-policies-service.js";

/** Backstop only: `resume` wakes parked jobs explicitly. */
const PAUSED_RUN_PARK_MS = 60 * 60 * 1_000;

interface BoundaryRuntimeContext {
  identity: Identity;
  /**
   * The run's caller (ADR 0055): the identity that triggered it — the
   * run's user with the scope stamped at trigger time. What host calls
   * and the documents surface act as; `identity` stays the run's
   * mechanics identity (tenant, user).
   */
  caller: Identity;
  runId: string;
  workflowStepAttemptId: string;
  projectId: string;
  workflowName: string;
  commitSha: string;
  artifactId: string;
  modulePath: string;
  exportName: string;
  stepIndex: number;
  input: Json | null;
  attempt: number;
  status: string;
  rateLimits: readonly RateLimit[];
}

export class BoundaryExecutionHandler {
  constructor(
    private readonly db: Kysely<DB>,
    private readonly deps: {
      coordinator: RunCoordinator;
      worker: ExecutionWorkerService;
      rateReservations: RateReservationsService;
      tenantPolicies: TenantPoliciesService;
      invokeRuntime(args: {
        identity: Identity;
        projectId: string;
        workflowName: string;
        commitSha: string;
        artifactId: string;
        invocationId: string;
        kind: "durable-boundary";
        modulePath: string;
        exportName: string;
        stepIndex: number;
        input: unknown;
        attempt: number;
        signal?: AbortSignal;
      }): Promise<RuntimeInvocationReceipt>;
      resolveChild(args: {
        identity: Identity;
        projectId: string;
        commitSha: string;
        workflowName: string;
      }): Promise<{
        capabilities: WorkflowCapabilities;
        execution: WorkflowExecutionDescriptor;
      }>;
      /**
       * Execute a host call transition (ADR 0055) as the run's caller. The
       * documents capability and the registry's `calls` both live here.
       */
      callHost(args: {
        caller: Identity;
        projectId: string;
        runId: string;
        workflowName: string;
        capability: string;
        fn: string;
        args: unknown;
      }): Promise<unknown>;
    },
  ) {
    deps.worker.registerHandler({
      kind: "durable_boundary",
      handler: ({ job, signal }) => this.execute({ job, signal }),
    });
    deps.worker.registerHandler({
      kind: "durable_pause_timeout",
      handler: ({ job, signal }) => {
        signal.throwIfAborted();
        return deps.coordinator.resolvePauseTimeout({ job });
      },
    });
  }

  private async execute(args: {
    job: ExecutionJob;
    signal: AbortSignal;
  }): Promise<void> {
    const context = await this.loadContext(args.job);
    if (!context || args.signal.aborted) return;
    if (context.status === "paused") {
      // Park rather than poll. A 100ms retry made every job on a paused run
      // spin through claim+release forever — at ~3ms a cycle, 10k paused jobs
      // demanded more database time than exists. `resume` wakes these jobs
      // explicitly, and release re-checks the run for a resume that landed
      // while this job was still leased; the interval is only a backstop.
      throw new ExecutionJobDeferredError(
        new Date(Date.now() + PAUSED_RUN_PARK_MS),
        { parkedForPausedRunId: context.runId },
      );
    }
    const invocationId = `${context.runId}:step:${context.stepIndex}:attempt:${context.attempt}`;
    // Reserved before the sandbox is touched, so a throttled boundary occupies
    // no compute while it waits and consumes no retry attempt.
    await this.reserveRateCapacity({ context, job: args.job });
    if (
      !(await this.deps.coordinator.beginAttempt({
        job: args.job,
        phase: "boundary",
      }))
    ) {
      return;
    }

    const receipt: RuntimeInvocationReceipt =
      await this.deps.coordinator.invokeRuntime({
        job: args.job,
        invocationId,
        invoke: () =>
          this.deps.invokeRuntime({
            ...context,
            invocationId,
            kind: "durable-boundary",
            // The caller rides beside the input (never inside it — input is
            // author-typed) so the boundary can read `context.caller`.
            input: {
              value: context.input,
              caller: {
                externalUserId: context.caller.externalUserId,
                ...(context.caller.scope
                  ? { scope: toJson(context.caller.scope) }
                  : {}),
              },
            },
            signal: args.signal,
          }),
      });
    if (receipt.terminal.status === "rate_limited") {
      // The provider is the authority on its own limits, so its answer blocks
      // every workflow sharing these buckets, not just this run.
      const retryAt = await this.applyRemoteBackpressure({
        context,
        retryAfterMs: receipt.terminal.retryAfterMs,
      });
      // The attempt row stays 'running', which beginAttempt re-accepts when the
      // job is redelivered, so the boundary resumes without burning an attempt.
      throw new ExecutionJobDeferredError(retryAt);
    }
    if (receipt.terminal.status !== "completed") {
      await this.deps.coordinator.failStep({
        workflowStepAttemptId: context.workflowStepAttemptId,
        job: args.job,
        error:
          "error" in receipt.terminal
            ? receipt.terminal.error
            : "Boundary invocation did not complete",
      });
      return;
    }
    const result = jsonRecord(receipt.terminal.result);
    if (result.type === "completed") {
      await this.deps.coordinator.completeStep({
        workflowStepAttemptId: context.workflowStepAttemptId,
        job: args.job,
        output: toJson(result.output),
      });
      return;
    }
    if (result.type === "pause") {
      await this.deps.coordinator.suspendForPause({
        workflowStepAttemptId: context.workflowStepAttemptId,
        job: args.job,
        transition: jsonRecord(result.transition),
      });
      return;
    }
    if (result.type === "child_workflow") {
      const transition = jsonRecord(result.transition);
      const workflow = jsonRecord(transition.workflow);
      const workflowName =
        stringValue(workflow.exportName) ?? stringValue(workflow.workflowName);
      if (!workflowName) {
        await this.deps.coordinator.failStep({
          workflowStepAttemptId: context.workflowStepAttemptId,
          job: args.job,
          error: "Child workflow target metadata is missing",
        });
        return;
      }
      const child = await this.deps.resolveChild({
        identity: context.identity,
        projectId: context.projectId,
        commitSha: context.commitSha,
        workflowName,
      });
      args.signal.throwIfAborted();
      await this.deps.coordinator.suspendForChild({
        workflowStepAttemptId: context.workflowStepAttemptId,
        job: args.job,
        child: {
          workflowName,
          capabilities: child.capabilities,
          execution: child.execution,
          input: toJson(transition.input),
        },
      });
      return;
    }
    if (result.type === "host_call") {
      const transition = jsonRecord(result.transition);
      const capability = stringValue(transition.capability);
      const fn = stringValue(transition.fn);
      if (!capability || !fn) {
        await this.deps.coordinator.failStep({
          workflowStepAttemptId: context.workflowStepAttemptId,
          job: args.job,
          error: "Host call transition is missing its capability or function",
        });
        return;
      }
      // Executed here, as the caller, and recorded as this step's output —
      // the next step receives it as input, like a child workflow's result.
      // A throw fails the step; the step's retry policy re-runs the call.
      let output: unknown;
      try {
        output = await this.deps.callHost({
          caller: context.caller,
          projectId: context.projectId,
          runId: context.runId,
          workflowName: context.workflowName,
          capability,
          fn,
          args: transition.args,
        });
      } catch (error) {
        await this.deps.coordinator.failStep({
          workflowStepAttemptId: context.workflowStepAttemptId,
          job: args.job,
          error: `Host call ${capability}.${fn} failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
        return;
      }
      args.signal.throwIfAborted();
      await this.deps.coordinator.completeStep({
        workflowStepAttemptId: context.workflowStepAttemptId,
        job: args.job,
        output: toJson(output === undefined ? null : output),
      });
      return;
    }
    await this.deps.coordinator.failStep({
      workflowStepAttemptId: context.workflowStepAttemptId,
      job: args.job,
      error: "Boundary returned an invalid result",
    });
  }

  private async reserveRateCapacity(args: {
    context: BoundaryRuntimeContext;
    job: ExecutionJob;
  }): Promise<void> {
    if (args.context.rateLimits.length === 0) return;
    const limits = await this.deps.tenantPolicies.applyRateOverrides({
      tenantId: args.context.identity.tenantId,
      limits: args.context.rateLimits,
    });
    const reservation = await this.deps.rateReservations.reserve({
      tenantId: args.context.identity.tenantId,
      limits,
    });
    if (!reservation.reserved) {
      await this.recordRateBlock({
        workflowStepAttemptId: args.context.workflowStepAttemptId,
        blockedUntil: reservation.retryAt,
        keys: reservation.blockedBy,
      });
      throw new ExecutionJobDeferredError(reservation.retryAt);
    }
    await this.recordRateBlock({
      workflowStepAttemptId: args.context.workflowStepAttemptId,
      blockedUntil: null,
      keys: null,
    });
  }

  private async applyRemoteBackpressure(args: {
    context: BoundaryRuntimeContext;
    retryAfterMs: number;
  }): Promise<Date> {
    const keys = args.context.rateLimits.map((limit) => limit.key);
    if (keys.length === 0) {
      return new Date(Date.now() + args.retryAfterMs);
    }
    const blockedUntil = await this.deps.rateReservations.applyRetryAfter({
      tenantId: args.context.identity.tenantId,
      keys,
      retryAfterMs: args.retryAfterMs,
    });
    await this.recordRateBlock({
      workflowStepAttemptId: args.context.workflowStepAttemptId,
      blockedUntil,
      keys,
    });
    return blockedUntil;
  }

  private async recordRateBlock(args: {
    workflowStepAttemptId: string;
    blockedUntil: Date | null;
    keys: readonly RateBucketKey[] | null;
  }): Promise<void> {
    await this.db
      .updateTable("workflow_step_attempts")
      .set({
        rate_blocked_until: args.blockedUntil,
        rate_blocked_keys: args.keys ? jsonColumn(toJson(args.keys)) : null,
        updated_at: new Date(),
      })
      .where("id", "=", args.workflowStepAttemptId)
      .execute();
  }

  private async loadContext(
    job: ExecutionJob,
  ): Promise<BoundaryRuntimeContext | null> {
    if (!job.workflowStepAttemptId) return null;
    const row = await this.db
      .selectFrom("workflow_step_attempts")
      .innerJoin(
        "workflow_runs",
        "workflow_runs.id",
        "workflow_step_attempts.run_id",
      )
      .innerJoin("projects", "projects.id", "workflow_runs.project_id")
      .innerJoin(
        "deployment_artifacts",
        "deployment_artifacts.id",
        "workflow_runs.deployment_artifact_id",
      )
      .innerJoin(
        "workflow_run_states",
        "workflow_run_states.run_id",
        "workflow_runs.id",
      )
      .where("workflow_step_attempts.id", "=", job.workflowStepAttemptId)
      .where("workflow_runs.id", "=", job.workflowRunId)
      .where("projects.tenant_id", "=", job.tenantId)
      .select([
        "workflow_runs.id as run_id",
        "workflow_runs.project_id",
        "workflow_runs.workflow_name",
        "workflow_runs.external_user_id",
        "workflow_runs.caller_scope",
        "workflow_runs.status",
        "workflow_runs.deployment_artifact_id",
        "deployment_artifacts.commit_sha",
        "projects.tenant_id",
        "workflow_step_attempts.id as workflow_step_attempt_id",
        "workflow_step_attempts.step_index",
        "workflow_step_attempts.input",
        "workflow_step_attempts.attempt",
        "workflow_step_attempts.policy",
        "workflow_run_states.execution_plan",
      ])
      .executeTakeFirst();
    if (!row?.external_user_id || !row.deployment_artifact_id) return null;
    const plan = jsonRecord(row.execution_plan);
    const target = jsonRecord(plan.exportTarget);
    const modulePath = stringValue(target.modulePath);
    const exportName = stringValue(target.exportName);
    if (!modulePath || !exportName)
      throw new Error("Execution target is invalid");
    const identity: Identity = {
      tenantId: row.tenant_id,
      externalUserId: row.external_user_id,
    };
    return {
      identity,
      caller: {
        ...identity,
        ...(Array.isArray(row.caller_scope)
          ? { scope: row.caller_scope as unknown as Identity["scope"] }
          : {}),
      },
      runId: row.run_id,
      workflowStepAttemptId: row.workflow_step_attempt_id,
      projectId: row.project_id,
      workflowName: row.workflow_name,
      commitSha: row.commit_sha,
      artifactId: row.deployment_artifact_id,
      modulePath,
      exportName,
      stepIndex: row.step_index,
      input: row.input,
      attempt: row.attempt,
      status: row.status,
      rateLimits: readRateLimits(row.policy),
    };
  }
}

function readRateLimits(policy: Json): readonly RateLimit[] {
  const value = jsonRecord(policy).rateLimits;
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const limit = jsonRecord(entry);
    const globalKey = stringValue(limit.globalKey);
    if (
      !globalKey ||
      typeof limit.capacity !== "number" ||
      typeof limit.refillRatePerSecond !== "number"
    ) {
      return [];
    }
    const partitionKey = stringValue(limit.partitionKey);
    return [
      {
        key: {
          globalKey,
          ...(partitionKey ? { partitionKey } : {}),
        },
        capacity: limit.capacity,
        refillRatePerSecond: limit.refillRatePerSecond,
        ...(typeof limit.cost === "number" ? { cost: limit.cost } : {}),
      },
    ];
  });
}
