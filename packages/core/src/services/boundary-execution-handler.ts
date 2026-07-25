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
import {
  jsonRecord,
  type RunCoordinator,
  stringValue,
  toJson,
} from "./run-coordinator.js";

interface BoundaryRuntimeContext {
  identity: Identity;
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
}

export class BoundaryExecutionHandler {
  constructor(
    private readonly db: Kysely<DB>,
    private readonly deps: {
      coordinator: RunCoordinator;
      worker: ExecutionWorkerService;
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
      throw new ExecutionJobDeferredError(new Date(Date.now() + 100));
    }
    const invocationId = `${context.runId}:step:${context.stepIndex}:attempt:${context.attempt}`;
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
            input: { value: context.input },
            signal: args.signal,
          }),
      });
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
    await this.deps.coordinator.failStep({
      workflowStepAttemptId: context.workflowStepAttemptId,
      job: args.job,
      error: "Boundary returned an invalid result",
    });
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
        "workflow_runs.status",
        "workflow_runs.deployment_artifact_id",
        "deployment_artifacts.commit_sha",
        "projects.tenant_id",
        "workflow_step_attempts.id as workflow_step_attempt_id",
        "workflow_step_attempts.step_index",
        "workflow_step_attempts.input",
        "workflow_step_attempts.attempt",
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
    return {
      identity: {
        tenantId: row.tenant_id,
        externalUserId: row.external_user_id,
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
    };
  }
}
