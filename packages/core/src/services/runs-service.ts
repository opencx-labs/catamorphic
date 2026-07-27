import type { DB, Json } from "@catamorphic/db";
import {
  fetchRemote,
  type CloneSource as GitCloneSource,
  type ProjectManager,
} from "@catamorphic/git";
import { getTracer, withSpan } from "@catamorphic/otel";
import {
  executionFiles,
  prepareWorkflowExecution,
  WORKFLOW_SOURCE_ROOT,
  type WorkflowCapabilities,
  type WorkflowExecutionDescriptor,
  type WorkflowGraph,
} from "@catamorphic/parser";
import {
  DeploymentRuntimeExecutorAdapter,
  RUNTIME_PROTOCOL_VERSION,
  RunExecutorImpl,
  type RunPluginPayload,
  type RunResult,
  RuntimeInfrastructureError,
  type RuntimeInvocation,
  type RuntimeInvocationReceipt,
  resolveWorkflowPackageFallback,
  type SandboxProvider,
  type WorkflowPackagePayload,
} from "@catamorphic/sandbox";
import type { Kysely, Selectable } from "kysely";
import type { Identity } from "../identity.js";
import {
  AppAccessDeniedError,
  assertProjectSurface,
  assertWorkflowAllowed,
  resolveAppAudience,
} from "./app-audience.js";
import type { AppPoliciesService } from "./app-policies-service.js";
import type {
  DeploymentArtifact,
  DeploymentArtifactsService,
} from "./deployment-artifacts-service.js";
import type { DeploymentRuntimeService } from "./deployment-runtime-service.js";
import type { DevSandboxService } from "./dev-sandbox-service.js";
import type {
  ExecutionJob,
  ExecutionJobsService,
} from "./execution-jobs-service.js";
import type {
  ExecutionWorkerHandle,
  ExecutionWorkerOptions,
  ExecutionWorkerService,
} from "./execution-worker-service.js";
import { uploadWorkspace } from "./playground/workspace-upload.js";
import { ProjectNotFoundError } from "./projects-service.js";
import type { RunCoordinator } from "./run-coordinator.js";
import { jsonColumn, jsonRecord, toJson } from "./run-coordinator.js";
import type { RunPluginsLoader } from "./run-plugins-loader.js";
import type { RuntimeEventsService } from "./runtime-events-service.js";
import type { TenantPoliciesService } from "./tenant-policies-service.js";
import { WorkflowNotFoundError } from "./workflows-service.js";

type RunRow = Selectable<DB["workflow_runs"]>;
type StepRow = Selectable<DB["workflow_run_steps"]>;

export type RunMode = "test" | "production";
export type RunStatus =
  | "pending"
  | "running"
  | "waiting"
  | "paused"
  | "canceling"
  | "completed"
  | "failed"
  | "canceled";
export type RunPhase =
  | "execute"
  | "boundary"
  | "source"
  | "process"
  | "sink"
  | "pause"
  | "child";
export type StepStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "skipped";

export interface RunProvenance {
  commitSha?: string;
  mutableSource?: true;
}

export interface RunArtifact {
  deploymentArtifactId: string;
}

export interface RunPause {
  id: string;
  status: "open" | "resumed" | "timed_out" | "canceled";
  state: unknown;
  timeoutAt: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export interface BatchProgress {
  workflowStepAttemptId: string;
  stepIndex: number;
  nodeId: string;
  attempt: number;
  status: WorkflowStepAttemptStatus;
  estimated: number | null;
  discovered: number;
  succeeded: number;
  failed: number;
  skipped: number;
  sinkCompletedChunks: number;
  sinkTotalChunks: number;
  artifact: unknown;
}

export interface RunCapabilities {
  cancel: boolean;
  pauseProcessing: boolean;
  resumeProcessing: boolean;
  submitInput: boolean;
  inspectItems: boolean;
}

export interface Run {
  id: string;
  projectId: string;
  workflowName: string;
  correlationKey: string | null;
  capabilities: RunCapabilities;
  status: RunStatus;
  phase: RunPhase;
  currentStepIndex: number | null;
  activePause: RunPause | null;
  batchScopes: BatchProgress[];
  provenance: RunProvenance;
  artifact?: RunArtifact;
  mode: RunMode;
  initiatedBy: string | null;
  input: unknown;
  result: unknown;
  error: string | null;
  parentRunId: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface RunStep {
  id: string;
  runId: string;
  nodeId: string;
  occurrence: number;
  attempt: number;
  name: string;
  status: StepStatus;
  input: unknown;
  output: unknown;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export type WorkflowStepAttemptStatus =
  | "pending"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "canceled";

export interface WorkflowStepAttempt {
  id: string;
  runId: string;
  stepIndex: number;
  nodeId: string;
  executor: "boundary" | "batch";
  attempt: number;
  status: WorkflowStepAttemptStatus;
  input: unknown;
  output: unknown;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface RunDetail extends Run {
  steps: RunStep[];
  workflowStepAttempts: WorkflowStepAttempt[];
}

export type BatchItemStatus =
  | "pending"
  | "running"
  | "waiting"
  | "succeeded"
  | "failed"
  | "skipped"
  | "canceled";

export interface BatchItem {
  id: string;
  runId: string;
  workflowStepAttemptId: string;
  key: string;
  sourceOrder: number;
  status: BatchItemStatus;
  value: unknown;
  output: unknown;
  error: string | null;
  currentNodeId: string | null;
  attempt: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface BatchItemStep {
  id: string;
  itemId: string;
  nodeId: string;
  occurrence: number;
  attempt: number;
  name: string;
  status: string;
  input: unknown;
  output: unknown;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface ListBatchItemsResult {
  items: BatchItem[];
  total: number;
}

export interface ListRunsResult {
  items: Run[];
  total: number;
}

export interface GetRunInput {
  identity: Identity;
  runId: string;
}

export interface ListRunsInput {
  identity: Identity;
  projectId: string;
  workflowName?: string;
  mode?: RunMode;
  /** Filters to one subject's journey — every run for a contact or account. */
  correlationKey?: string;
  limit?: number;
  offset?: number;
}

/**
 * How to handle a trigger whose correlation key already has a live run.
 *
 * - `ignore` returns the existing run untouched, which makes a redelivered
 *   webhook a no-op.
 * - `error` surfaces {@link RunEnrollmentConflictError}.
 * - `restart` cancels the live run and enrolls a fresh one.
 */
export type EnrollmentConflictPolicy = "ignore" | "error" | "restart";

export interface TriggerProductionRunInput {
  identity: Identity;
  projectId: string;
  workflowName: string;
  input?: Json;
  /**
   * A host-meaningful identity for the subject of this run — a contact, an
   * account, a subscription. Unique among live runs of the same workflow, so
   * it is both an enrollment idempotency key and the address used by
   * `signalByKey` and `cancelByKey`.
   */
  correlationKey?: string;
  /** Defaults to `ignore`. */
  onConflict?: EnrollmentConflictPolicy;
}

export interface TriggerTestRunInput extends TriggerProductionRunInput {
  files?: Record<string, string>;
}

export interface CancelRunInput extends GetRunInput {
  reason?: string;
}

export type PauseRunInput = GetRunInput;
export type ResumeRunInput = GetRunInput;

export interface ResumeRunPauseInput extends GetRunInput {
  pauseId: string;
  idempotencyKey: string;
  value: Json;
}

export interface ListBatchItemsInput extends GetRunInput {
  workflowStepAttemptId: string;
  status?: BatchItemStatus;
  limit?: number;
  offset?: number;
}

export interface ListBatchItemStepsInput extends GetRunInput {
  workflowStepAttemptId: string;
  itemId: string;
}

export interface RedriveRunJobInput {
  tenantId: string;
  jobId: string;
  availableAt?: Date;
}

export class RunNotFoundError extends Error {
  constructor(readonly runId: string) {
    super(`Run '${runId}' not found`);
    this.name = "RunNotFoundError";
  }
}

export class RunCapabilityError extends Error {
  constructor(
    readonly capability: keyof WorkflowCapabilities | keyof RunCapabilities,
    readonly operation: string,
  ) {
    super(`Run operation '${operation}' is unavailable for '${capability}'`);
    this.name = "RunCapabilityError";
  }
}

export class PluginSecretsMissingError extends Error {
  constructor(readonly missing: string[]) {
    super(`Missing required plugin secrets: ${missing.join(", ")}`);
    this.name = "PluginSecretsMissingError";
  }
}

export class SandboxProviderNotConfiguredError extends Error {
  constructor() {
    super("Sandbox provider not configured");
    this.name = "SandboxProviderNotConfiguredError";
  }
}

export class RunEnrollmentConflictError extends Error {
  constructor(
    readonly workflowName: string,
    readonly correlationKey: string,
    /** Null when a competing enrollment won the race and then went terminal. */
    readonly runId: string | null,
  ) {
    super(
      `Workflow '${workflowName}' already has an active run for correlation key '${correlationKey}'`,
    );
    this.name = "RunEnrollmentConflictError";
  }
}

export class RunSignalNotFoundError extends Error {
  constructor(
    readonly workflowName: string,
    readonly correlationKey: string,
    readonly signal: string,
  ) {
    super(
      `Workflow '${workflowName}' has no run awaiting signal '${signal}' for correlation key '${correlationKey}'`,
    );
    this.name = "RunSignalNotFoundError";
  }
}

export class ProductionDeploymentNotFoundError extends Error {
  constructor(readonly projectId: string) {
    super(`Project '${projectId}' has no deployed main revision`);
    this.name = "ProductionDeploymentNotFoundError";
  }
}

export class InvalidRunOverlayError extends Error {
  constructor(readonly filePath: string) {
    super(`Invalid test run overlay path '${filePath}'`);
    this.name = "InvalidRunOverlayError";
  }
}

function requireCorrelationKey(value: string): string {
  if (value.length === 0 || value.length > 500) {
    throw new Error("correlationKey must contain between 1 and 500 characters");
  }
  return value;
}

type EnrollmentDecision =
  | { kind: "proceed" }
  | { kind: "existing"; run: Run }
  | { kind: "restart"; runId: string };

/**
 * Detects the enrollment uniqueness violation specifically, so a genuine
 * conflict is not confused with any other insert failure.
 */
function isCorrelationKeyConflict(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const record = error as { code?: unknown; constraint?: unknown };
  return (
    record.code === "23505" &&
    record.constraint === "uq_workflow_runs_correlation_active"
  );
}

interface RunsServiceDeps {
  appPolicies?: AppPoliciesService;
  projectManager: ProjectManager;
  sandboxProvider?: SandboxProvider;
  devSandboxes?: DevSandboxService;
  runPluginsLoader?: RunPluginsLoader;
  deploymentArtifacts: DeploymentArtifactsService;
  deploymentRuntime?: DeploymentRuntimeService;
  executionJobs: ExecutionJobsService;
  executionWorker: ExecutionWorkerService;
  runtimeEvents: RuntimeEventsService;
  coordinator: RunCoordinator;
  tenantPolicies: TenantPoliciesService;
}

interface PreparedSource {
  files: Record<string, string>;
  originalFiles: Record<string, string>;
  workflowFile: string;
  graph: WorkflowGraph;
  commitSha: string | null;
  cloneSource?: GitCloneSource & { commitSha: string };
  workflowPackage?: WorkflowPackagePayload;
}

const tracer = getTracer("@catamorphic/core");

export class RunsService {
  private readonly executor?: RunExecutorImpl;
  private readonly preparedSources = new Map<string, Promise<PreparedSource>>();

  constructor(
    private readonly db: Kysely<DB>,
    private readonly deps: RunsServiceDeps,
  ) {
    this.executor = deps.sandboxProvider
      ? new RunExecutorImpl({ provider: deps.sandboxProvider })
      : undefined;
    deps.executionWorker.registerHandler({
      kind: "workflow_run",
      handler: ({ job, signal }) => this.executeProductionJob({ job, signal }),
    });
  }

  startWorker(args: ExecutionWorkerOptions = {}): ExecutionWorkerHandle {
    return this.deps.executionWorker.start(args);
  }

  stopWorkers(): Promise<void> {
    return this.deps.executionWorker.stopAll();
  }

  redriveJob(args: RedriveRunJobInput): Promise<boolean> {
    return this.deps.executionJobs.redrive(args);
  }

  async get(args: GetRunInput): Promise<RunDetail> {
    const row = await this.db
      .selectFrom("workflow_runs")
      .innerJoin("projects", "projects.id", "workflow_runs.project_id")
      .leftJoin(
        "workflow_run_states",
        "workflow_run_states.run_id",
        "workflow_runs.id",
      )
      .where("workflow_runs.id", "=", args.runId)
      .where("projects.tenant_id", "=", args.identity.tenantId)
      .selectAll("workflow_runs")
      .select([
        "workflow_run_states.current_step_index",
        "workflow_run_states.active_workflow_step_attempt_id",
      ])
      .executeTakeFirst();
    if (!row) {
      // Uniform denial for audience identities: a 404-for-missing /
      // 403-for-denied split would let a guest probe which run ids exist.
      if (args.identity.appAudience) throw new AppAccessDeniedError();
      throw new RunNotFoundError(args.runId);
    }
    if (args.identity.appAudience) {
      // Run polling mirrors triggering (ADR 0036): an audience identity may
      // read only production runs of workflows in its frozen set, within the
      // project its version belongs to — never arbitrary tenant runs by id.
      const context = await resolveAppAudience({
        db: this.db,
        identity: args.identity,
        projectId: row.project_id,
        policies: this.deps.appPolicies,
      });
      if (
        row.mode !== "production" ||
        !context?.allowedWorkflows.has(row.workflow_name)
      ) {
        throw new AppAccessDeniedError();
      }
    }
    const [pause, batches, steps, attempts] = await Promise.all([
      this.db
        .selectFrom("workflow_pauses")
        .where("run_id", "=", args.runId)
        .where("status", "=", "open")
        .selectAll()
        .executeTakeFirst(),
      this.db
        .selectFrom("batch_execution_states")
        .innerJoin(
          "workflow_step_attempts",
          "workflow_step_attempts.id",
          "batch_execution_states.workflow_step_attempt_id",
        )
        .where("batch_execution_states.run_id", "=", args.runId)
        .selectAll("batch_execution_states")
        .select([
          "workflow_step_attempts.step_index",
          "workflow_step_attempts.step_node_id",
          "workflow_step_attempts.attempt",
          "workflow_step_attempts.status",
        ])
        .orderBy("workflow_step_attempts.step_index")
        .orderBy("workflow_step_attempts.attempt")
        .execute(),
      this.db
        .selectFrom("workflow_run_steps")
        .where("run_id", "=", args.runId)
        .selectAll()
        .orderBy("started_at")
        .execute(),
      this.db
        .selectFrom("workflow_step_attempts")
        .where("run_id", "=", args.runId)
        .selectAll()
        .orderBy("step_index")
        .orderBy("attempt")
        .execute(),
    ]);
    return {
      ...mapRun({
        row,
        pause,
        batchScopes: batches.map(mapBatchProgress),
      }),
      steps: steps.map(mapStep),
      workflowStepAttempts: attempts.map((attempt) => ({
        id: attempt.id,
        runId: attempt.run_id,
        stepIndex: attempt.step_index,
        nodeId: attempt.step_node_id,
        executor: attempt.executor === "batch" ? "batch" : "boundary",
        attempt: attempt.attempt,
        status: parseAttemptStatus(attempt.status),
        input: attempt.input,
        output: attempt.output,
        error: attempt.error,
        startedAt: attempt.started_at?.toISOString() ?? null,
        completedAt: attempt.completed_at?.toISOString() ?? null,
      })),
    };
  }

  async listItems(args: ListBatchItemsInput): Promise<ListBatchItemsResult> {
    assertProjectSurface(args.identity);
    await this.requireBatchScope(args);
    const limit = Math.max(1, Math.min(args.limit ?? 100, 500));
    const offset = Math.max(0, args.offset ?? 0);
    let query = this.db
      .selectFrom("batch_items")
      .where("run_id", "=", args.runId)
      .where("workflow_step_attempt_id", "=", args.workflowStepAttemptId);
    let countQuery = this.db
      .selectFrom("batch_items")
      .where("run_id", "=", args.runId)
      .where("workflow_step_attempt_id", "=", args.workflowStepAttemptId);
    if (args.status) {
      query = query.where("status", "=", args.status);
      countQuery = countQuery.where("status", "=", args.status);
    }
    const [rows, count] = await Promise.all([
      query
        .selectAll()
        .orderBy("source_order")
        .limit(limit)
        .offset(offset)
        .execute(),
      countQuery
        .select((eb) => eb.fn.countAll<number>().as("count"))
        .executeTakeFirstOrThrow(),
    ]);
    return {
      items: rows.map((row) => ({
        id: row.id,
        runId: row.run_id,
        workflowStepAttemptId: row.workflow_step_attempt_id,
        key: row.item_key,
        sourceOrder: Number(row.source_order),
        status: parseBatchItemStatus(row.status),
        value: row.value,
        output: row.output,
        error: row.error,
        currentNodeId: row.current_node_id,
        attempt: row.attempt,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
        completedAt: row.completed_at?.toISOString() ?? null,
      })),
      total: Number(count.count),
    };
  }

  async listItemSteps(args: ListBatchItemStepsInput): Promise<BatchItemStep[]> {
    assertProjectSurface(args.identity);
    await this.requireBatchScope(args);
    const item = await this.db
      .selectFrom("batch_items")
      .where("id", "=", args.itemId)
      .where("run_id", "=", args.runId)
      .where("workflow_step_attempt_id", "=", args.workflowStepAttemptId)
      .select("id")
      .executeTakeFirst();
    if (!item) throw new RunNotFoundError(args.runId);
    const rows = await this.db
      .selectFrom("batch_item_steps")
      .where("run_id", "=", args.runId)
      .where("workflow_step_attempt_id", "=", args.workflowStepAttemptId)
      .where("item_id", "=", args.itemId)
      .selectAll()
      .orderBy("attempt")
      .orderBy("started_at")
      .orderBy("occurrence")
      .execute();
    return rows.map((row) => ({
      id: row.id,
      itemId: row.item_id,
      nodeId: row.node_id,
      occurrence: row.occurrence,
      attempt: row.attempt,
      name: row.name,
      status: row.status,
      input: row.input,
      output: row.output,
      error: row.error,
      startedAt: row.started_at?.toISOString() ?? null,
      completedAt: row.completed_at?.toISOString() ?? null,
    }));
  }

  async list(args: ListRunsInput): Promise<ListRunsResult> {
    await this.requireProject(args.identity, args.projectId);
    const audience = await resolveAppAudience({
      db: this.db,
      identity: args.identity,
      projectId: args.projectId,
      policies: this.deps.appPolicies,
    });
    const limit = Math.max(1, Math.min(args.limit ?? 50, 100));
    const offset = Math.max(0, args.offset ?? 0);
    let query = this.db
      .selectFrom("workflow_runs")
      .leftJoin(
        "workflow_run_states",
        "workflow_run_states.run_id",
        "workflow_runs.id",
      )
      .where("project_id", "=", args.projectId);
    let countQuery = this.db
      .selectFrom("workflow_runs")
      .where("project_id", "=", args.projectId);
    if (audience) {
      // Audience identities see only production runs of their frozen set —
      // the read-side mirror of the trigger gate (ADR 0036).
      if (
        args.mode === "test" ||
        (args.workflowName && !audience.allowedWorkflows.has(args.workflowName))
      ) {
        throw new AppAccessDeniedError();
      }
      const frozen = [...audience.allowedWorkflows];
      if (frozen.length === 0) return { items: [], total: 0 };
      query = query
        .where("workflow_name", "in", frozen)
        .where("mode", "=", "production");
      countQuery = countQuery
        .where("workflow_name", "in", frozen)
        .where("mode", "=", "production");
    }
    if (args.workflowName) {
      query = query.where("workflow_name", "=", args.workflowName);
      countQuery = countQuery.where("workflow_name", "=", args.workflowName);
    }
    if (args.mode) {
      query = query.where("mode", "=", args.mode);
      countQuery = countQuery.where("mode", "=", args.mode);
    }
    if (args.correlationKey) {
      query = query.where("correlation_key", "=", args.correlationKey);
      countQuery = countQuery.where(
        "correlation_key",
        "=",
        args.correlationKey,
      );
    }
    const [rows, count] = await Promise.all([
      query
        .selectAll("workflow_runs")
        .select([
          "workflow_run_states.current_step_index",
          "workflow_run_states.active_workflow_step_attempt_id",
        ])
        .orderBy("created_at", "desc")
        .limit(limit)
        .offset(offset)
        .execute(),
      countQuery
        .select((eb) => eb.fn.countAll<number>().as("count"))
        .executeTakeFirstOrThrow(),
    ]);
    const runIds = rows.map((row) => row.id);
    const [pauses, batches] =
      runIds.length === 0
        ? [[], []]
        : await Promise.all([
            this.db
              .selectFrom("workflow_pauses")
              .where("run_id", "in", runIds)
              .where("status", "=", "open")
              .selectAll()
              .execute(),
            this.db
              .selectFrom("batch_execution_states")
              .innerJoin(
                "workflow_step_attempts",
                "workflow_step_attempts.id",
                "batch_execution_states.workflow_step_attempt_id",
              )
              .where("batch_execution_states.run_id", "in", runIds)
              .selectAll("batch_execution_states")
              .select([
                "workflow_step_attempts.step_index",
                "workflow_step_attempts.step_node_id",
                "workflow_step_attempts.attempt",
                "workflow_step_attempts.status",
              ])
              .orderBy("workflow_step_attempts.step_index")
              .orderBy("workflow_step_attempts.attempt")
              .execute(),
          ]);
    const pausesByRun = new Map(pauses.map((pause) => [pause.run_id, pause]));
    const batchesByRun = new Map<string, BatchProgress[]>();
    for (const batch of batches) {
      const scopes = batchesByRun.get(batch.run_id) ?? [];
      scopes.push(mapBatchProgress(batch));
      batchesByRun.set(batch.run_id, scopes);
    }
    return {
      items: rows.map((row) =>
        mapRun({
          row,
          pause: pausesByRun.get(row.id),
          batchScopes: batchesByRun.get(row.id) ?? [],
        }),
      ),
      total: Number(count.count),
    };
  }

  async triggerProduction(args: TriggerProductionRunInput): Promise<Run> {
    return this.trigger({ ...args, mode: "production" });
  }

  async triggerTest(args: {
    identity: Identity;
    projectId: string;
    workflowName: string;
    input?: Json;
    files?: Record<string, string>;
  }): Promise<Run> {
    return this.trigger({ ...args, mode: "test" });
  }

  async cancel(args: CancelRunInput): Promise<Run> {
    assertProjectSurface(args.identity);
    const invocations = await this.deps.coordinator.cancel(args);
    await Promise.all(
      invocations.map((invocation) =>
        this.deps.deploymentRuntime?.cancel(invocation).catch(() => {}),
      ),
    );
    return this.get(args);
  }

  async pause(args: PauseRunInput): Promise<Run> {
    assertProjectSurface(args.identity);
    const outcome = await this.deps.coordinator.pauseOperator(args);
    if (outcome === "unavailable") {
      throw new RunCapabilityError("pauseProcessing", "pause");
    }
    return this.get(args);
  }

  async resume(args: ResumeRunInput): Promise<Run> {
    assertProjectSurface(args.identity);
    const outcome = await this.deps.coordinator.resumeOperator(args);
    if (outcome === "unavailable") {
      throw new RunCapabilityError("resumeProcessing", "resume");
    }
    return this.get(args);
  }

  async resumePause(args: ResumeRunPauseInput): Promise<Run> {
    assertProjectSurface(args.identity);
    await this.deps.coordinator.resumePause(args);
    return this.get(args);
  }

  /**
   * Delivers an external event to whichever run is currently waiting on a named
   * signal for this correlation key.
   *
   * This is the read side of enrollment: the caller knows the contact, not the
   * run. Resolution is by (workflow, key, signal name), so a webhook handler
   * never has to track run ids.
   */
  async signalByKey(args: {
    identity: Identity;
    projectId: string;
    workflowName: string;
    correlationKey: string;
    signal: string;
    idempotencyKey: string;
    value: Json;
  }): Promise<Run> {
    assertProjectSurface(args.identity);
    const run = await this.findActiveByKey(args);
    if (!run) {
      throw new RunSignalNotFoundError(
        args.workflowName,
        args.correlationKey,
        args.signal,
      );
    }
    const pause = await this.db
      .selectFrom("workflow_pauses")
      .where("run_id", "=", run.id)
      .where("signal_name", "=", args.signal)
      .where("status", "=", "open")
      .select("id")
      .executeTakeFirst();
    if (!pause) {
      throw new RunSignalNotFoundError(
        args.workflowName,
        args.correlationKey,
        args.signal,
      );
    }
    return this.resumePause({
      identity: args.identity,
      runId: run.id,
      pauseId: pause.id,
      idempotencyKey: args.idempotencyKey,
      value: args.value,
    });
  }

  /**
   * Terminates the live run for a correlation key wherever it currently sits.
   *
   * This is the right shape for an opt-out: unsubscribing is not "resume this
   * pause with a value", it is "stop this journey", which run-tree cancellation
   * already models. Returns null when nothing was live, so a duplicate opt-out
   * is a no-op rather than an error.
   */
  async cancelByKey(args: {
    identity: Identity;
    projectId: string;
    workflowName: string;
    correlationKey: string;
    reason?: string;
  }): Promise<Run | null> {
    assertProjectSurface(args.identity);
    const run = await this.findActiveByKey(args);
    if (!run) return null;
    return this.cancel({
      identity: args.identity,
      runId: run.id,
      ...(args.reason === undefined ? {} : { reason: args.reason }),
    });
  }

  private async findActiveByKey(args: {
    identity: Identity;
    projectId: string;
    workflowName: string;
    correlationKey: string;
  }): Promise<{ id: string } | null> {
    await this.requireProject(args.identity, args.projectId);
    const row = await this.db
      .selectFrom("workflow_runs")
      .where("project_id", "=", args.projectId)
      .where("workflow_name", "=", args.workflowName)
      .where("correlation_key", "=", args.correlationKey)
      .where("status", "not in", ["completed", "failed", "canceled"])
      .select("id")
      .executeTakeFirst();
    return row ?? null;
  }

  /**
   * Decides what an enrollment should do about an already-live run for the same
   * key. Deliberately performs no writes: a `restart` cancels only once the new
   * run is ready to be inserted, so a failure in between cannot leave the
   * subject with no journey at all.
   */
  private async resolveEnrollmentConflict(args: {
    identity: Identity;
    projectId: string;
    workflowName: string;
    correlationKey: string;
    onConflict: EnrollmentConflictPolicy;
  }): Promise<EnrollmentDecision> {
    const existing = await this.findActiveByKey(args);
    if (!existing) return { kind: "proceed" };
    if (args.onConflict === "error") {
      throw new RunEnrollmentConflictError(
        args.workflowName,
        args.correlationKey,
        existing.id,
      );
    }
    if (args.onConflict === "ignore") {
      return {
        kind: "existing",
        run: await this.get({ identity: args.identity, runId: existing.id }),
      };
    }
    return { kind: "restart", runId: existing.id };
  }

  /**
   * Resolves the enrollment race that the pre-insert check cannot: artifact
   * preparation sits between check and insert, so two concurrent enrollments
   * for one key can both pass it and collide on the unique index.
   *
   * `ignore` stays idempotent by returning the run that won, which is what a
   * redelivered webhook wants. The other policies surface a conflict, because
   * the caller asked to observe or replace a run that a competing enrollment
   * has since changed.
   */
  private async resolveEnrollmentRace(args: {
    identity: Identity;
    projectId: string;
    workflowName: string;
    correlationKey: string;
    onConflict: EnrollmentConflictPolicy;
  }): Promise<Run> {
    const winner = await this.findActiveByKey(args);
    if (winner && args.onConflict === "ignore") {
      return this.get({ identity: args.identity, runId: winner.id });
    }
    throw new RunEnrollmentConflictError(
      args.workflowName,
      args.correlationKey,
      winner?.id ?? null,
    );
  }

  async resolveProductionArtifact(args: {
    identity: Identity;
    projectId: string;
    workflowName: string;
  }): Promise<DeploymentArtifact> {
    await this.requireProject(args.identity, args.projectId);
    const source = await this.prepareProductionSource(args);
    if (!source.commitSha)
      throw new ProductionDeploymentNotFoundError(args.projectId);
    const plugins = await this.loadPlugins(
      args.identity,
      args.projectId,
      "production",
    );
    return this.deps.deploymentArtifacts.ensure({
      tenantId: args.identity.tenantId,
      projectId: args.projectId,
      commitSha: source.commitSha,
      files: source.files,
      plugins: runtimePackages({
        plugins: plugins?.plugins,
        workflowPackage: source.workflowPackage,
      }),
    });
  }

  async resolveProductionExecution(args: {
    identity: Identity;
    projectId: string;
    workflowName: string;
    commitSha: string;
  }): Promise<WorkflowExecutionDescriptor> {
    return (await this.prepareProductionSource(args)).graph.execution;
  }

  /**
   * Materializes the production runtime for an artifact before any run needs
   * it, so the first trigger does not pay the full cold start (sandbox create,
   * workspace upload, dependency install, supervisor boot) on its critical
   * path. Hosts call this at deploy time; it is the same ensure the invoke
   * path uses, so a warm runtime is simply found and reused.
   */
  async warmProductionRuntime(args: {
    identity: Identity;
    projectId: string;
    workflowName: string;
    commitSha: string;
    artifactId: string;
  }): Promise<void> {
    const deploymentRuntime = this.deps.deploymentRuntime;
    if (!deploymentRuntime) throw new SandboxProviderNotConfiguredError();
    const [source, plugins, artifact] = await Promise.all([
      this.prepareProductionSource(args),
      this.loadPlugins(args.identity, args.projectId, "production"),
      this.deps.deploymentArtifacts.get({ artifactId: args.artifactId }),
    ]);
    if (!artifact) {
      throw new Error(`Deployment artifact '${args.artifactId}' not found`);
    }
    await deploymentRuntime.ensure({
      projectId: args.projectId,
      artifact,
      files: source.files,
      originalFiles: source.originalFiles,
      cloneSource: source.cloneSource,
      plugins: runtimePackages({
        plugins: plugins?.plugins,
        workflowPackage: source.workflowPackage,
      }),
    });
  }

  async resolveProductionWorkflow(args: {
    identity: Identity;
    projectId: string;
    workflowName: string;
    commitSha: string;
  }): Promise<{
    capabilities: WorkflowCapabilities;
    execution: WorkflowExecutionDescriptor;
  }> {
    const graph = (await this.prepareProductionSource(args)).graph;
    return {
      capabilities: graph.capabilities,
      execution: graph.execution,
    };
  }

  async invokeProductionRuntime(args: {
    identity: Identity;
    projectId: string;
    workflowName: string;
    commitSha: string;
    artifactId: string;
    invocationId: string;
    kind: RuntimeInvocation["kind"];
    operation?: string;
    exportName?: string;
    modulePath?: string;
    stepIndex?: number;
    input: unknown;
    attempt: number;
    timeoutSeconds?: number;
    signal?: AbortSignal;
  }): Promise<RuntimeInvocationReceipt> {
    args.signal?.throwIfAborted();
    const provider = this.deps.sandboxProvider;
    const deploymentRuntime = this.deps.deploymentRuntime;
    if (!provider?.deploymentRuntime || !deploymentRuntime) {
      throw new SandboxProviderNotConfiguredError();
    }
    const [source, plugins, artifact] = await Promise.all([
      this.prepareProductionSource(args),
      this.loadPlugins(args.identity, args.projectId, "production"),
      this.deps.deploymentArtifacts.get({ artifactId: args.artifactId }),
    ]);
    const runtimePackagesForArtifact = runtimePackages({
      plugins: plugins?.plugins,
      workflowPackage: source.workflowPackage,
    });
    if (
      !artifact ||
      !(await this.deps.deploymentArtifacts.verify({
        artifact,
        projectId: args.projectId,
        commitSha: args.commitSha,
        files: source.files,
        plugins: runtimePackagesForArtifact,
      }))
    ) {
      throw new Error(
        `Deployment artifact '${args.artifactId}' does not match run`,
      );
    }
    const runtime = await deploymentRuntime.ensure({
      projectId: args.projectId,
      artifact,
      files: source.files,
      originalFiles: source.originalFiles,
      cloneSource: source.cloneSource,
      plugins: runtimePackagesForArtifact,
    });
    const base = {
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      runtimeId: runtime.runtimeId,
      invocationId: args.invocationId,
      deploymentArtifactId: artifact.id,
      artifactDigest: artifact.artifactDigest,
      transformVersion: artifact.transformVersion,
      runtimeVersion: artifact.runtimeVersion,
      input: args.input,
      attempt: args.attempt,
      deadlineAt: new Date(
        Date.now() + (args.timeoutSeconds ?? 300) * 1_000,
      ).toISOString(),
      env: plugins?.secrets,
      signal: args.signal,
    } as const;
    const targetBase = {
      modulePath: args.modulePath ?? source.workflowFile,
      exportName: args.exportName ?? args.workflowName,
    };
    if (args.kind === "workflow") {
      const receipt = await provider.deploymentRuntime.invoke({
        ...base,
        kind: args.kind,
        target: targetBase,
      });
      args.signal?.throwIfAborted();
      return receipt;
    }
    if (args.kind === "durable-boundary") {
      const receipt = await provider.deploymentRuntime.invoke({
        ...base,
        kind: args.kind,
        target: { ...targetBase, stepIndex: requireStepIndex(args.stepIndex) },
      });
      args.signal?.throwIfAborted();
      return receipt;
    }
    if (args.kind === "batch-source") {
      const operation = args.operation;
      if (operation !== "initialize" && operation !== "readPage") {
        throw new Error("Invalid batch source operation");
      }
      const receipt = await provider.deploymentRuntime.invoke({
        ...base,
        kind: args.kind,
        target: {
          ...targetBase,
          stepIndex: requireStepIndex(args.stepIndex),
          operation,
        },
      });
      args.signal?.throwIfAborted();
      return receipt;
    }
    if (args.kind === "batch-step") {
      if (args.operation === "run") {
        const receipt = await provider.deploymentRuntime.invoke({
          ...base,
          kind: args.kind,
          target: { ...targetBase, operation: "run" },
        });
        args.signal?.throwIfAborted();
        return receipt;
      }
      if (args.operation !== "process")
        throw new Error("Invalid batch step operation");
      const receipt = await provider.deploymentRuntime.invoke({
        ...base,
        kind: args.kind,
        target: {
          ...targetBase,
          stepIndex: requireStepIndex(args.stepIndex),
          operation: "process",
        },
      });
      args.signal?.throwIfAborted();
      return receipt;
    }
    const operation = args.operation;
    if (
      operation !== "inspect" &&
      operation !== "initialize" &&
      operation !== "writeBatch" &&
      operation !== "finalize"
    ) {
      throw new Error("Invalid batch sink operation");
    }
    const receipt = await provider.deploymentRuntime.invoke({
      ...base,
      kind: args.kind,
      target: {
        ...targetBase,
        stepIndex: requireStepIndex(args.stepIndex),
        operation,
      },
    });
    args.signal?.throwIfAborted();
    return receipt;
  }

  private async trigger(args: {
    identity: Identity;
    projectId: string;
    workflowName: string;
    input?: Json;
    files?: Record<string, string>;
    mode: RunMode;
  }): Promise<Run> {
    return withSpan(
      {
        tracer,
        name: "workflow.run",
        attributes: {
          "catamorphic.project.id": args.projectId,
          "catamorphic.workflow.name": args.workflowName,
          "catamorphic.tenant.id": args.identity.tenantId,
          "catamorphic.run.mode": args.mode,
        },
      },
      async (span) => {
        if (args.identity.appAudience) {
          // App viewers reach exactly the frozen workflow set, and only in
          // production: test runs execute the builder's mutable dev tree.
          if (args.mode !== "production") throw new AppAccessDeniedError();
          await assertWorkflowAllowed({
            db: this.db,
            identity: args.identity,
            projectId: args.projectId,
            workflowName: args.workflowName,
            policies: this.deps.appPolicies,
          });
        }
        const run = await this.triggerInner(args);
        span.setAttribute("catamorphic.run.id", run.id);
        span.setAttribute("catamorphic.run.status", run.status);
        return run;
      },
    );
  }

  private async triggerInner(args: {
    identity: Identity;
    projectId: string;
    workflowName: string;
    input?: Json;
    files?: Record<string, string>;
    mode: RunMode;
    correlationKey?: string;
    onConflict?: EnrollmentConflictPolicy;
  }): Promise<Run> {
    const provider = this.deps.sandboxProvider;
    const executor = this.executor;
    if (!provider || !executor) throw new SandboxProviderNotConfiguredError();
    await this.requireProject(args.identity, args.projectId);
    const correlationKey = args.correlationKey
      ? requireCorrelationKey(args.correlationKey)
      : undefined;
    if (correlationKey && args.mode === "test") {
      throw new RunCapabilityError("persistedContinuations", "triggerTest");
    }
    const onConflict = args.onConflict ?? "ignore";
    let supersededRunId: string | null = null;
    if (correlationKey) {
      const decision = await this.resolveEnrollmentConflict({
        identity: args.identity,
        projectId: args.projectId,
        workflowName: args.workflowName,
        correlationKey,
        onConflict,
      });
      if (decision.kind === "existing") return decision.run;
      if (decision.kind === "restart") supersededRunId = decision.runId;
    }
    const source =
      args.mode === "test"
        ? await this.prepareTestSource(args)
        : await this.prepareProductionSource(args);
    if (args.mode === "test" && source.graph.execution.steps.length > 0) {
      throw new RunCapabilityError("persistedContinuations", "triggerTest");
    }
    const plugins = await this.loadPlugins(
      args.identity,
      args.projectId,
      args.mode,
    );
    const input = args.input ?? null;
    const runId = crypto.randomUUID();
    const provenance: RunProvenance = source.commitSha
      ? { commitSha: source.commitSha }
      : { mutableSource: true };
    if (args.mode === "production") {
      if (!source.commitSha)
        throw new ProductionDeploymentNotFoundError(args.projectId);
      const artifact = await this.deps.deploymentArtifacts.ensure({
        tenantId: args.identity.tenantId,
        projectId: args.projectId,
        commitSha: source.commitSha,
        files: source.files,
        plugins: runtimePackages({
          plugins: plugins?.plugins,
          workflowPackage: source.workflowPackage,
        }),
      });
      // Deferred to here so everything that can fail an enrollment — source
      // preparation, artifact build — has already succeeded. Cancelling any
      // earlier risks ending the old journey without starting a new one.
      if (supersededRunId) {
        await this.cancel({
          identity: args.identity,
          runId: supersededRunId,
          reason: `Re-enrolled for correlation key '${correlationKey}'`,
        });
      }
      try {
        await this.db.transaction().execute(async (trx) => {
          // A restart replaces a run it already cancelled, so it cannot grow
          // the active set. Counting it would let a cap lowered under existing
          // load strand the subject: cancelled, then refused re-entry.
          if (!supersededRunId) {
            await this.deps.tenantPolicies.assertActiveRunCapacity({
              trx,
              tenantId: args.identity.tenantId,
            });
          }
          await trx
            .insertInto("workflow_runs")
            .values({
              id: runId,
              project_id: args.projectId,
              workflow_name: args.workflowName,
              correlation_key: correlationKey ?? null,
              mode: "production",
              provenance: toJson({
                ...provenance,
                capabilities: source.graph.capabilities,
              }),
              deployment_artifact_id: artifact.id,
              external_user_id: args.identity.externalUserId,
              status: "pending",
              phase:
                source.graph.execution.steps[0]?.type === "batch"
                  ? "source"
                  : source.graph.execution.steps.length > 0
                    ? "boundary"
                    : "execute",
              input: jsonColumn(input),
            })
            .execute();
          if (source.graph.execution.steps.length === 0) {
            await this.deps.executionJobs.enqueue({
              trx,
              tenantId: args.identity.tenantId,
              workflowRunId: runId,
              kind: "workflow_run",
              payload: {},
              priority: 100,
              dedupeKey: `run:${runId}:execute`,
            });
          } else {
            await this.deps.coordinator.initialize({
              trx,
              tenantId: args.identity.tenantId,
              runId,
              execution: source.graph.execution,
              input,
            });
          }
        });
      } catch (error) {
        if (correlationKey && isCorrelationKeyConflict(error)) {
          return this.resolveEnrollmentRace({
            identity: args.identity,
            projectId: args.projectId,
            workflowName: args.workflowName,
            correlationKey,
            onConflict,
          });
        }
        throw error;
      }
      return this.get({ identity: args.identity, runId });
    }

    const now = new Date();
    await this.db
      .insertInto("workflow_runs")
      .values({
        id: runId,
        project_id: args.projectId,
        workflow_name: args.workflowName,
        mode: "test",
        provenance: toJson({
          ...provenance,
          capabilities: source.graph.capabilities,
        }),
        external_user_id: args.identity.externalUserId,
        status: "running",
        phase: "execute",
        input: jsonColumn(input),
        started_at: now,
      })
      .execute();
    const result = await this.executePlain({
      identity: args.identity,
      projectId: args.projectId,
      workflowName: args.workflowName,
      mode: "test",
      runId,
      source,
      input,
      plugins,
      provider,
      executor,
    });
    await this.finalizePlainRun({ runId, result });
    return this.get({ identity: args.identity, runId });
  }

  private async executeProductionJob(args: {
    job: ExecutionJob;
    signal: AbortSignal;
  }): Promise<void> {
    const row = await this.db
      .selectFrom("workflow_runs")
      .innerJoin("projects", "projects.id", "workflow_runs.project_id")
      .where("workflow_runs.id", "=", args.job.workflowRunId)
      .where("projects.tenant_id", "=", args.job.tenantId)
      .selectAll("workflow_runs")
      .select("projects.tenant_id")
      .executeTakeFirst();
    if (!row) throw new RunNotFoundError(args.job.workflowRunId);
    if (!(await this.deps.coordinator.beginPlainRun({ job: args.job }))) return;
    const provenance = jsonRecord(row.provenance);
    const commitSha =
      typeof provenance.commitSha === "string"
        ? provenance.commitSha
        : undefined;
    if (!commitSha || !row.external_user_id || !row.deployment_artifact_id) {
      throw new Error(`Production run '${row.id}' has incomplete provenance`);
    }
    if (args.signal.aborted)
      throw new Error("Execution worker stopped before invocation");
    const identity: Identity = {
      tenantId: row.tenant_id,
      externalUserId: row.external_user_id,
    };
    const provider = this.deps.sandboxProvider;
    const executor = this.executor;
    if (!provider || !executor) throw new SandboxProviderNotConfiguredError();
    const source = await this.prepareProductionSource({
      identity,
      projectId: row.project_id,
      workflowName: row.workflow_name,
      commitSha,
    });
    if (source.graph.execution.steps.length !== 0) {
      throw new Error("Defined workflow was dispatched as a plain workflow");
    }
    const [plugins, artifact] = await Promise.all([
      this.loadPlugins(identity, row.project_id, "production"),
      this.deps.deploymentArtifacts.get({
        artifactId: row.deployment_artifact_id,
      }),
    ]);
    if (
      !artifact ||
      !(await this.deps.deploymentArtifacts.verify({
        artifact,
        projectId: row.project_id,
        commitSha,
        files: source.files,
        plugins: runtimePackages({
          plugins: plugins?.plugins,
          workflowPackage: source.workflowPackage,
        }),
      }))
    )
      throw new Error(`Production run '${row.id}' has no artifact`);
    const invocationId = `${row.id}:${args.job.attempt}`;
    const result = await this.deps.coordinator.invokeRuntime({
      job: args.job,
      invocationId,
      invoke: () =>
        this.executePlain({
          identity,
          projectId: row.project_id,
          workflowName: row.workflow_name,
          mode: "production",
          runId: row.id,
          source,
          input: row.input,
          plugins,
          provider,
          executor,
          artifact,
          invocationId,
          invocationAttempt: args.job.attempt,
          signal: args.signal,
        }),
    });
    await this.deps.coordinator.finalizePlainRun({
      job: args.job,
      result,
    });
  }

  private async executePlain(args: {
    identity: Identity;
    projectId: string;
    workflowName: string;
    mode: RunMode;
    runId: string;
    source: PreparedSource;
    input: Json;
    plugins?: Awaited<ReturnType<RunPluginsLoader["load"]>>;
    provider: SandboxProvider;
    executor: RunExecutorImpl;
    artifact?: DeploymentArtifact;
    invocationId?: string;
    invocationAttempt?: number;
    signal?: AbortSignal;
  }): Promise<RunResult> {
    let sandboxId: string | undefined;
    let workingDirectory: string | undefined;
    let destroySandbox = false;
    try {
      args.signal?.throwIfAborted();
      if (
        args.mode === "production" &&
        args.artifact &&
        this.deps.deploymentRuntime &&
        args.provider.deploymentRuntime
      ) {
        const runtime = await this.deps.deploymentRuntime.ensure({
          projectId: args.projectId,
          artifact: args.artifact,
          files: args.source.files,
          originalFiles: args.source.originalFiles,
          cloneSource: args.source.cloneSource,
          plugins: runtimePackages({
            plugins: args.plugins?.plugins,
            workflowPackage: args.source.workflowPackage,
          }),
        });
        const runtimeExecutor = new DeploymentRuntimeExecutorAdapter({
          provider: args.provider,
          runtime,
          invocationId: args.invocationId,
          invocationAttempt: args.invocationAttempt,
          replay: await this.deps.runtimeEvents.replay({
            tenantId: args.identity.tenantId,
            runId: args.runId,
          }),
          eventSink: this.deps.runtimeEvents.sink({
            tenantId: args.identity.tenantId,
            runId: args.runId,
          }),
        });
        const result = await runtimeExecutor.executeRun({
          sandboxId: runtime.sandboxId,
          workingDirectory: `${args.provider.workspaceRoot}/deployments/${args.artifact.id}/project`,
          workflowFile: args.source.workflowFile,
          workflowName: args.workflowName,
          triggerData: args.input,
          runId: args.runId,
          plugins: runtimePackages({
            plugins: args.plugins?.plugins,
            workflowPackage: args.source.workflowPackage,
          }),
          secrets: args.plugins?.secrets,
        });
        args.signal?.throwIfAborted();
        return result;
      }
      if (args.mode === "test") {
        const dev = await this.requireDevSandboxes().ensure({
          identity: args.identity,
          projectId: args.projectId,
          refresh: false,
        });
        sandboxId = dev.providerId;
        workingDirectory = `${args.provider.workspaceRoot}/runs/${args.runId}`;
        await args.provider.executeCommand(
          sandboxId,
          `rm -rf ${shellQuote(workingDirectory)} && mkdir -p ${shellQuote(workingDirectory)}`,
        );
        await uploadWorkspace({
          provider: args.provider,
          sandboxId,
          projectDir: workingDirectory,
          files: args.source.files,
        });
      } else {
        const handle = await args.provider.createSandbox({
          language: "typescript",
          autoStopInterval: 5,
          labels: {
            purpose: "execution",
            projectId: args.projectId,
            commitSha: args.source.commitSha ?? "",
          },
        });
        sandboxId = handle.providerId;
        destroySandbox = true;
        workingDirectory = `${args.provider.workspaceRoot}/project`;
        if (args.source.cloneSource) {
          await args.provider.gitClone(
            sandboxId,
            args.source.cloneSource.url,
            workingDirectory,
            {
              branch: args.source.cloneSource.branch,
              commitId: args.source.commitSha ?? undefined,
              username: args.source.cloneSource.username,
              password: args.source.cloneSource.password,
            },
          );
          const transformed = changedFiles({
            before: args.source.originalFiles,
            after: args.source.files,
          });
          if (Object.keys(transformed).length > 0) {
            await uploadWorkspace({
              provider: args.provider,
              sandboxId,
              projectDir: workingDirectory,
              files: transformed,
            });
          }
        } else {
          await uploadWorkspace({
            provider: args.provider,
            sandboxId,
            projectDir: workingDirectory,
            files: args.source.files,
          });
        }
      }
      const result = await args.executor.executeRun({
        sandboxId,
        workingDirectory,
        workflowFile: args.source.workflowFile,
        workflowName: args.workflowName,
        triggerData: args.input,
        runId: args.runId,
        plugins: runtimePackages({
          plugins: args.plugins?.plugins,
          workflowPackage: args.source.workflowPackage,
        }),
        secrets: args.plugins?.secrets,
      });
      args.signal?.throwIfAborted();
      return result;
    } catch (error) {
      if (args.signal?.aborted) throw error;
      if (args.mode === "production") {
        if (error instanceof RuntimeInfrastructureError) throw error;
        throw new RuntimeInfrastructureError({
          operation: `production run '${args.runId}' execution`,
          cause: error,
        });
      }
      return {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        steps: [],
      };
    } finally {
      if (sandboxId && workingDirectory && args.mode === "test") {
        await args.provider
          .executeCommand(sandboxId, `rm -rf ${shellQuote(workingDirectory)}`)
          .catch(() => {});
      }
      if (sandboxId && destroySandbox) {
        await args.provider.destroySandbox(sandboxId).catch(() => {});
      }
    }
  }

  private async finalizePlainRun(args: {
    runId: string;
    result: RunResult;
  }): Promise<boolean> {
    const now = new Date();
    return this.db.transaction().execute(async (trx) => {
      const updated = await trx
        .updateTable("workflow_runs")
        .set({
          status: args.result.status,
          result: jsonColumn(toJson(args.result.result)),
          error: args.result.error ?? null,
          completed_at: now,
          updated_at: now,
        })
        .where("id", "=", args.runId)
        .where("status", "in", ["pending", "running"])
        .returning("id")
        .executeTakeFirst();
      if (!updated) return false;
      if (args.result.steps.length === 0) return true;
      await trx
        .insertInto("workflow_run_steps")
        .values(
          args.result.steps.map((step) => ({
            id: crypto.randomUUID(),
            run_id: args.runId,
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
      return true;
    });
  }

  private async prepareTestSource(args: {
    identity: Identity;
    projectId: string;
    workflowName: string;
    files?: Record<string, string>;
  }): Promise<PreparedSource> {
    const repo = await this.deps.projectManager.openDev(
      args.identity.tenantId,
      args.projectId,
      args.identity.externalUserId,
    );
    try {
      const originalFiles = await repo.readAllFiles();
      const overlays = args.files ?? {};
      assertOverlayPaths(overlays);
      return prepareSource({
        projectId: args.projectId,
        workflowName: args.workflowName,
        files: { ...originalFiles, ...overlays },
        originalFiles,
        commitSha: null,
      });
    } finally {
      await repo.dispose();
    }
  }

  private async prepareProductionSource(args: {
    identity: Identity;
    projectId: string;
    workflowName: string;
    commitSha?: string;
  }): Promise<PreparedSource> {
    const remote = this.deps.projectManager.remoteBackend;
    if (!remote) throw new ProductionDeploymentNotFoundError(args.projectId);

    // A pinned sha names immutable content, so the parse behind it can be
    // reused. Without a sha the caller is asking "whatever main is now", which
    // has to hit the remote to answer.
    const cached = args.commitSha
      ? this.recallPreparedSource(
          preparedSourceKey({ ...args, commitSha: args.commitSha }),
        )
      : undefined;
    const resolved = await (cached ??
      this.loadProductionSource({ ...args, remote }));

    // Clone credentials are short-lived, so they are fetched per call and
    // layered onto the cached parse rather than cached with it.
    const cloneSource = remote.getCloneSource
      ? await remote.getCloneSource(args.identity.tenantId, args.projectId, {
          scope: "read",
        })
      : undefined;
    return {
      ...resolved,
      cloneSource:
        cloneSource && resolved.commitSha
          ? { ...cloneSource, commitSha: resolved.commitSha }
          : undefined,
    };
  }

  /**
   * Reads a commit and parses it into an executable source.
   *
   * Every durable boundary and every batch item invokes the runtime, and each
   * invocation needs the transformed source. Recomputing it per invocation
   * means a full git fetch plus a whole-project ts-morph parse per step, so a
   * 10k-item batch parses the project 10k times. Results are memoised by
   * (tenant, project, workflow, sha) — a sha is immutable, so a hit is always
   * valid.
   *
   * The promise is cached before it settles, so concurrent items on the same
   * commit collapse into one parse instead of stampeding.
   */
  private loadProductionSource(args: {
    identity: Identity;
    projectId: string;
    workflowName: string;
    commitSha?: string;
    remote: NonNullable<ProjectManager["remoteBackend"]>;
  }): Promise<PreparedSource> {
    const load = (async () => {
      const repo = await this.deps.projectManager.openDev(
        args.identity.tenantId,
        args.projectId,
        args.identity.externalUserId,
      );
      try {
        await fetchRemote({
          dev: repo,
          remote: args.remote,
          tenantId: args.identity.tenantId,
          projectId: args.projectId,
          remoteBranch: "main",
        });
        const commitSha =
          args.commitSha ??
          (await repo.resolveRef("refs/remotes/origin/main").catch(() => null));
        if (!commitSha)
          throw new ProductionDeploymentNotFoundError(args.projectId);
        const files = await repo.readAllFilesAtRef(commitSha);
        return await prepareSource({
          projectId: args.projectId,
          workflowName: args.workflowName,
          files,
          originalFiles: files,
          commitSha,
        });
      } finally {
        await repo.dispose();
      }
    })();

    if (!args.commitSha) return load;
    const key = preparedSourceKey({ ...args, commitSha: args.commitSha });
    // Each deploy strands its predecessor's entry, so the map is capped and
    // evicted least-recently-used (recallPreparedSource refreshes recency, and
    // Map preserves insertion order). Evicting by insertion alone would purge
    // the busiest entry on schedule under multi-tenant load: with more than
    // PREPARED_SOURCE_CACHE_MAX live (tenant, project, workflow, sha) keys,
    // the hottest batch re-pays a git fetch and full parse every cycle.
    if (this.preparedSources.size >= PREPARED_SOURCE_CACHE_MAX) {
      const oldest = this.preparedSources.keys().next();
      if (!oldest.done) this.preparedSources.delete(oldest.value);
    }
    this.preparedSources.set(key, load);
    // A failed parse must not be remembered, or the run retries against a
    // cached rejection forever.
    void load.catch(() => this.preparedSources.delete(key));
    return load;
  }

  /** Cache hit that also refreshes the entry's recency for LRU eviction. */
  private recallPreparedSource(
    key: string,
  ): Promise<PreparedSource> | undefined {
    const hit = this.preparedSources.get(key);
    if (!hit) return undefined;
    this.preparedSources.delete(key);
    this.preparedSources.set(key, hit);
    return hit;
  }

  private async loadPlugins(
    identity: Identity,
    projectId: string,
    mode: RunMode,
  ) {
    if (!this.deps.runPluginsLoader) return undefined;
    const plugins = await this.deps.runPluginsLoader.load({
      identity,
      projectId,
      environment: mode,
    });
    if (plugins.missingRequiredSecrets.length > 0) {
      throw new PluginSecretsMissingError(plugins.missingRequiredSecrets);
    }
    return plugins;
  }

  private requireDevSandboxes(): DevSandboxService {
    if (!this.deps.devSandboxes) throw new SandboxProviderNotConfiguredError();
    return this.deps.devSandboxes;
  }

  private async requireProject(
    identity: Identity,
    projectId: string,
  ): Promise<void> {
    const row = await this.db
      .selectFrom("projects")
      .where("id", "=", projectId)
      .where("tenant_id", "=", identity.tenantId)
      .select("id")
      .executeTakeFirst();
    if (!row) throw new ProjectNotFoundError(projectId);
  }

  private async requireBatchScope(args: {
    identity: Identity;
    runId: string;
    workflowStepAttemptId: string;
  }): Promise<void> {
    const scope = await this.db
      .selectFrom("batch_execution_states")
      .innerJoin(
        "workflow_runs",
        "workflow_runs.id",
        "batch_execution_states.run_id",
      )
      .innerJoin("projects", "projects.id", "workflow_runs.project_id")
      .where("batch_execution_states.run_id", "=", args.runId)
      .where(
        "batch_execution_states.workflow_step_attempt_id",
        "=",
        args.workflowStepAttemptId,
      )
      .where("projects.tenant_id", "=", args.identity.tenantId)
      .select("batch_execution_states.run_id")
      .executeTakeFirst();
    if (!scope) throw new RunNotFoundError(args.runId);
  }
}

const PREPARED_SOURCE_CACHE_MAX = 32;

function preparedSourceKey(args: {
  identity: Identity;
  projectId: string;
  workflowName: string;
  commitSha: string;
}): string {
  return [
    args.identity.tenantId,
    args.projectId,
    args.workflowName,
    args.commitSha,
  ].join(" ");
}

async function prepareSource(args: {
  projectId: string;
  workflowName: string;
  files: Record<string, string>;
  originalFiles: Record<string, string>;
  commitSha: string | null;
}): Promise<PreparedSource> {
  const files = executionFiles(args.files);
  const prepared = prepareWorkflowExecution({
    files,
    workflowName: args.workflowName,
  });
  if (!prepared?.graph.filePath) {
    throw new WorkflowNotFoundError(args.projectId, args.workflowName);
  }
  return {
    files: prepared.files,
    originalFiles: executionFiles(args.originalFiles),
    workflowFile: prepared.graph.filePath,
    graph: prepared.graph,
    commitSha: args.commitSha,
    workflowPackage: await resolveWorkflowPackageFallback({
      packageJson: workflowPackageJson(files),
    }),
  };
}

/**
 * The workflow package declaration lives in the workflows workspace member;
 * projects predating the workspace layout keep it at the root.
 */
function workflowPackageJson(
  files: Record<string, string>,
): string | undefined {
  return files[`${WORKFLOW_SOURCE_ROOT}/package.json`] ?? files["package.json"];
}

function mapRun(args: {
  row: RunRow & {
    current_step_index: number | null;
    active_workflow_step_attempt_id: string | null;
  };
  pause: Selectable<DB["workflow_pauses"]> | undefined;
  batchScopes: BatchProgress[];
}): Run {
  const provenance = jsonRecord(args.row.provenance);
  const active = ["pending", "running", "waiting", "paused"].includes(
    args.row.status,
  );
  const activeBatch = args.batchScopes.some(
    (scope) =>
      scope.workflowStepAttemptId === args.row.active_workflow_step_attempt_id,
  );
  const processingPhase =
    args.row.phase === "source" ||
    args.row.phase === "process" ||
    args.row.phase === "sink";
  const openPause = args.pause?.status === "open";
  return {
    id: args.row.id,
    projectId: args.row.project_id,
    workflowName: args.row.workflow_name,
    correlationKey: args.row.correlation_key,
    capabilities: {
      cancel: active,
      pauseProcessing:
        activeBatch &&
        processingPhase &&
        args.row.status !== "paused" &&
        !openPause,
      resumeProcessing: activeBatch && args.row.status === "paused",
      submitInput:
        active &&
        args.row.status === "waiting" &&
        args.row.phase === "pause" &&
        openPause,
      inspectItems: args.batchScopes.length > 0,
    },
    status: parseRunStatus(args.row.status),
    phase: parseRunPhase(args.row.phase),
    currentStepIndex: args.row.current_step_index,
    activePause: args.pause
      ? {
          id: args.pause.id,
          status: args.pause.status as RunPause["status"],
          state: args.pause.state,
          timeoutAt: args.pause.timeout_at?.toISOString() ?? null,
          createdAt: args.pause.created_at.toISOString(),
          resolvedAt: args.pause.resolved_at?.toISOString() ?? null,
        }
      : null,
    batchScopes: args.batchScopes,
    provenance: {
      ...(typeof provenance.commitSha === "string"
        ? { commitSha: provenance.commitSha }
        : {}),
      ...(provenance.mutableSource === true
        ? { mutableSource: true as const }
        : {}),
    },
    ...(args.row.deployment_artifact_id
      ? { artifact: { deploymentArtifactId: args.row.deployment_artifact_id } }
      : {}),
    mode: args.row.mode === "test" ? "test" : "production",
    initiatedBy: args.row.external_user_id,
    input: args.row.input,
    result: args.row.result,
    error: args.row.error,
    parentRunId: args.row.parent_run_id,
    createdAt: args.row.created_at.toISOString(),
    updatedAt: args.row.updated_at.toISOString(),
    startedAt: args.row.started_at?.toISOString() ?? null,
    completedAt: args.row.completed_at?.toISOString() ?? null,
  };
}

function mapBatchProgress(
  row: Selectable<DB["batch_execution_states"]> & {
    step_index: number;
    step_node_id: string;
    attempt: number;
    status: string;
  },
): BatchProgress {
  return {
    workflowStepAttemptId: row.workflow_step_attempt_id,
    stepIndex: row.step_index,
    nodeId: row.step_node_id,
    attempt: row.attempt,
    status: parseAttemptStatus(row.status),
    estimated:
      row.estimated_count === null ? null : Number(row.estimated_count),
    discovered: Number(row.discovered_count),
    succeeded: Number(row.completed_count),
    failed: Number(row.failed_count),
    skipped: Number(row.skipped_count),
    sinkCompletedChunks: Number(row.sink_completed_chunks),
    sinkTotalChunks: Number(row.sink_total_chunks),
    artifact: row.sink_artifact,
  };
}

function mapStep(row: StepRow): RunStep {
  return {
    id: row.id,
    runId: row.run_id,
    nodeId: row.node_id,
    occurrence: row.occurrence,
    attempt: row.attempt,
    name: row.name,
    status: row.status as StepStatus,
    input: row.input,
    output: row.output,
    error: row.error,
    startedAt: row.started_at?.toISOString() ?? null,
    completedAt: row.completed_at?.toISOString() ?? null,
  };
}

function parseRunStatus(value: string): RunStatus {
  if (
    value === "pending" ||
    value === "running" ||
    value === "waiting" ||
    value === "paused" ||
    value === "canceling" ||
    value === "completed" ||
    value === "failed" ||
    value === "canceled"
  ) {
    return value;
  }
  throw new Error(`Unknown run status '${value}'`);
}

function parseRunPhase(value: string): RunPhase {
  if (
    value === "execute" ||
    value === "boundary" ||
    value === "source" ||
    value === "process" ||
    value === "sink" ||
    value === "pause" ||
    value === "child"
  ) {
    return value;
  }
  throw new Error(`Unknown run phase '${value}'`);
}

function parseAttemptStatus(value: string): WorkflowStepAttempt["status"] {
  if (
    value === "pending" ||
    value === "running" ||
    value === "waiting" ||
    value === "completed" ||
    value === "failed" ||
    value === "canceled"
  ) {
    return value;
  }
  throw new Error(`Unknown workflow step attempt status '${value}'`);
}

function parseBatchItemStatus(value: string): BatchItemStatus {
  if (
    value === "pending" ||
    value === "running" ||
    value === "waiting" ||
    value === "succeeded" ||
    value === "failed" ||
    value === "skipped" ||
    value === "canceled"
  ) {
    return value;
  }
  throw new Error(`Unknown batch item status '${value}'`);
}

function requireStepIndex(value: number | undefined): number {
  if (value === undefined) throw new Error("Runtime target requires stepIndex");
  return value;
}

function runtimePackages(args: {
  plugins?: readonly RunPluginPayload[];
  workflowPackage?: WorkflowPackagePayload;
}): RunPluginPayload[] | undefined {
  const packages = [
    ...(args.plugins ?? []),
    ...(args.workflowPackage ? [args.workflowPackage] : []),
  ];
  return packages.length > 0 ? packages : undefined;
}

function changedFiles(args: {
  before: Record<string, string>;
  after: Record<string, string>;
}): Record<string, string> {
  return Object.fromEntries(
    Object.entries(args.after).filter(
      ([path, content]) => args.before[path] !== content,
    ),
  );
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function assertOverlayPaths(files: Record<string, string>): void {
  for (const filePath of Object.keys(files)) {
    const parts = filePath.split("/");
    if (
      filePath.startsWith("/") ||
      filePath.includes("\0") ||
      parts.some((part) => part === "" || part === "." || part === "..")
    ) {
      throw new InvalidRunOverlayError(filePath);
    }
  }
}
