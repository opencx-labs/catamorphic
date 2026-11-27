import { createHash } from "node:crypto";
import type { DB, Json } from "@catamorphic/db";
import { type ProjectManager, refreshPublished } from "@catamorphic/git";
import { getTracer, setSpanCorrelation, withSpan } from "@catamorphic/otel";
import {
  executionFiles,
  prepareWorkflowExecution,
  validateAgainstSchema,
  type WorkflowCapabilities,
  type WorkflowExecutionDescriptor,
  type WorkflowGraph,
} from "@catamorphic/parser";
import {
  RUNTIME_PROTOCOL_VERSION,
  type RunPluginPayload,
  type RuntimeInvocation,
  type RuntimeInvocationReceipt,
  resolveWorkflowPackageFallback,
  type SandboxProvider,
  type WorkflowPackagePayload,
} from "@catamorphic/sandbox";
import {
  hasProjectLockfile,
  isProjectSourcePath,
  MANAGED_BRANCH_PREFIX,
  PROJECT_WORKFLOWS_PACKAGE_PATH,
  publishedRef,
} from "@catamorphic/workflow/project-layout";
import { type Kysely, type Selectable, sql, type Transaction } from "kysely";
import {
  assertTokenScope,
  hasProjectPermission,
  type Identity,
  identityCovers,
  identityMayUseConnection,
  identityMayUseEnvironment,
  intersectProjectPermissions,
  intersectScope,
  isProjectPrincipal,
  narrowStoreDocuments,
} from "../identity.js";
import { assertAgentSessionAccess } from "./agent-session-access.js";
import { allocationSandboxProvider } from "./allocation-sandbox-provider.js";
import type { AppPoliciesService } from "./app-policies-service.js";
import {
  AccessDeniedError,
  assertProjectPermission,
  assertScopeAllowsWorkflow,
  resolveScope,
} from "./artifact-scope.js";
import type { ConnectionAdmissionService } from "./connection-admission.js";
import type { ResolvedConnectionBinding } from "./connection-types.js";
import {
  AuthenticationRequiredError,
  ConnectionNotFoundError,
  ConnectionPermissionDeniedError,
} from "./connections-service.js";
import type {
  DeploymentArtifact,
  DeploymentArtifactsService,
} from "./deployment-artifacts-service.js";
import type { DeploymentRuntimeService } from "./deployment-runtime-service.js";
import { DeploymentRuntimeService as EnvironmentDeploymentRuntimeService } from "./deployment-runtime-service.js";
import { KyselyDeploymentRuntimeStore } from "./deployment-runtime-store.js";
import type { DevSandboxService } from "./dev-sandbox-service.js";
import {
  ExecutionAllocationConflictError,
  type ExecutionAllocationsService,
} from "./execution-allocations-service.js";
import {
  admissionPolicy,
  EnvironmentAccessDeniedError,
  EnvironmentBindingUnavailableError,
  EnvironmentIncompatibleError,
  EnvironmentNotFoundError,
  EnvironmentPolicyInvalidError,
  type ExecutionEnvironmentsService,
  NoCompatibleEnvironmentError,
} from "./execution-environments-service.js";
import type { ExecutionJobsService } from "./execution-jobs-service.js";
import type {
  ExecutionWorkerHandle,
  ExecutionWorkerOptions,
  ExecutionWorkerService,
} from "./execution-worker-service.js";
import { ProjectNotFoundError } from "./projects-service.js";
import type { RunCoordinator } from "./run-coordinator.js";
import { jsonColumn, jsonRecord, toJson } from "./run-coordinator.js";
import type { RunPluginsLoader } from "./run-plugins-loader.js";
import type { RunSignalReceipt, SignalRunInput } from "./run-signals.js";
import type { RuntimeEventsService } from "./runtime-events-service.js";
import {
  TenantActiveRunLimitError,
  type TenantPoliciesService,
} from "./tenant-policies-service.js";
import { EnvironmentCapacityError } from "./worker-capacity.js";
import type { WorkflowEnablement } from "./workflow-enablement-types.js";
import {
  WorkflowEnablementNotFoundError,
  WorkflowEnablementSuspendedError,
  type WorkflowEnablementsService,
} from "./workflow-enablements-service.js";
import { WorkflowNotFoundError } from "./workflows-service.js";

type RunRow = Selectable<DB["workflow_runs"]>;
type StepRow = Selectable<DB["workflow_run_steps"]>;

export type RunStatus =
  /** Waiting for the active run of its key to settle (ADR 0325). */
  | "queued"
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
  /** The workflow's `@displayname` at that commit, when it declares one. */
  displayName?: string;
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

export interface RunConnectionActionRequired {
  id: string;
  environment: string;
  alias: string;
  status: "pending";
  createdAt: string;
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
  environment: string | null;
  allocationId: string | null;
  workflowEnablementId: string | null;
  capabilities: RunCapabilities;
  status: RunStatus;
  phase: RunPhase;
  currentStepIndex: number | null;
  activePause: RunPause | null;
  connectionActionRequired: RunConnectionActionRequired | null;
  batchScopes: BatchProgress[];
  provenance: RunProvenance;
  artifact?: RunArtifact;
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
 * - `queue` records the run as `queued`; it starts, in arrival order, once
 *   every earlier run for the key has settled (ADR 0325).
 */
export type EnrollmentConflictPolicy = "ignore" | "error" | "restart" | "queue";

export interface TriggerProductionRunInput {
  identity: Identity;
  projectId: string;
  workflowName: string;
  environment?: string;
  input?: Json;
  /**
   * A host-meaningful identity for the subject of this run — a contact, an
   * account, a subscription. Unique among live runs of the same workflow, so
   * it is both an enrollment idempotency key and the address used by
   * `signalByKey` and `cancelByKey`.
   */
  correlationKey?: string;
  /**
   * Defaults to `ignore`. Without a `correlationKey`, the workflow's declared
   * `concurrency` supplies both the key and the policy (ADR 0325).
   */
  onConflict?: EnrollmentConflictPolicy;
  /**
   * One delivery's identity (a webhook's id, a schedule occurrence): a
   * workflow starts at most one run for it, whatever that run's status.
   */
  deliveryKey?: string;
}

/**
 * Facts about a run only Work states, never taken from a caller's input:
 * the Project Event whose delivery started it (ADR 0355).
 */
interface RunInternalFacts {
  /** The event this run is a delivery of, stamped as `event_id`. */
  eventId?: string;
  /**
   * An event the host delivers and no caller waits for (ADR 0337): the only
   * enrollment that may join a queued run alike it. Calls, synchronous
   * fires and the runs of a waited event (ADR 0355) report their own run's
   * outcome, so never join.
   */
  delivery?: true;
  /** The host kind whose dispatch starts this run (ADR 0327). */
  dispatchedKind?: string;
}

/**
 * The host's own dispatch of a trigger kind, passed by the trigger
 * dispatcher alone: a workflow bound to a host-only kind starts only so.
 */
export interface HostDispatch {
  kind: string;
  /** `async`: an event delivery no caller waits for, which may join. */
  mode?: "async" | "sync";
  /**
   * The Project Event this delivery is of (ADR 0355), stamped on the run
   * it starts. A `waited` one has an emitter waiting for that run's own
   * end, so it never joins another.
   */
  event?: { id: string; waited: boolean };
}

/**
 * A workflow bound to a host-only trigger kind (machine provisioners, ADR
 * 0327) starts only through the host's dispatch of that kind, never from
 * a caller's run, an app, a tool or another workflow.
 */
export class WorkflowHostOnlyError extends AccessDeniedError {
  constructor(
    readonly workflowName: string,
    readonly kinds: readonly string[],
  ) {
    super(
      `Workflow '${workflowName}' is started only by the host's ${kinds.join(" or ")} dispatch`,
    );
    this.name = "WorkflowHostOnlyError";
  }
}

export interface TriggerPinnedRunInput extends TriggerProductionRunInput {
  commitSha: string;
  /** Remote branch/ref that makes the pinned commit fetchable. */
  remoteBranch: string;
}

export type RunSuspensionReason =
  | "pause"
  | "child"
  | "paused"
  | "backoff"
  | "batch"
  | "budget"
  | "queue";

/**
 * How a synchronous call settled. `completed` and `failed` are terminal;
 * `suspended` means the run is still live — it reached a durable wait (a
 * pause, a child, a retry backoff, a batch) or the call's wall-clock budget —
 * and the polling workers carry it on. Callers keep `runId` either way.
 */
export type RunCallOutcome =
  | { status: "completed"; runId: string; output: Json }
  | { status: "failed"; runId: string; error: string }
  | { status: "suspended"; runId: string; suspendedOn: RunSuspensionReason };

export interface CallRunInput extends TriggerProductionRunInput {
  /**
   * Wall-clock budget before detaching with `suspended: budget`. Clamped to
   * [1s, 5min]; defaults to 30s.
   */
  budgetMs?: number;
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

/** A workflow cannot run at a published revision under its consent (ADR 0331). */
export class WorkflowRevisionUnavailableError extends Error {
  constructor(
    readonly reason: string,
    /**
     * `needs_consent`: the revision asks for more authority; `skipped`: the
     * workflow does not build there; `retry`: a failure that may clear.
     */
    readonly kind: "needs_consent" | "skipped" | "retry",
  ) {
    super(reason);
    this.name = "WorkflowRevisionUnavailableError";
  }
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
    super(
      "This host has no execution environment for workflows. The host passes a sandbox or local-process provider when it creates Catamorphic.",
    );
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

/** A key holds at most this many queued runs (ADR 0325). */
export const MAX_QUEUED_RUNS_PER_KEY = 100;

/**
 * Starts a queued run tries before an unexpected failure fails it, so a
 * broken head cannot hold its key for ever (ADR 0325). Waiting for room has
 * no bound: the run waits as long as it is queued.
 */
export const MAX_QUEUED_START_ATTEMPTS = 8;

interface QueuedHead {
  id: string;
  project_id: string;
  workflow_name: string;
  correlation_key: string | null;
  external_user_id: string | null;
  caller_scope: Json | null;
  input: Json | null;
  enrollment: Json | null;
  queue_attempts: number;
  tenant_id: string;
}

function dispatchFacts(dispatch: HostDispatch | undefined): RunInternalFacts {
  if (!dispatch) return {};
  return {
    dispatchedKind: dispatch.kind,
    ...(dispatch.event ? { eventId: dispatch.event.id } : {}),
    ...(dispatch.mode === "async" && !dispatch.event?.waited
      ? { delivery: true as const }
      : {}),
  };
}

/**
 * Why a queued run did not start: not its turn yet, no room (a full or
 * offline machine, the tenant's run limit), a refusal that will not change
 * (lost authority, a removed workflow or enablement, a broken source or
 * policy), or anything else, retried with backoff. A connection that is
 * unavailable for now is the last kind: follow and deploy retry it too.
 */
function queuedStartOutcome(
  error: unknown,
): "not_ready" | "room" | "refused" | "retry" {
  if (
    error instanceof QueuedRunNotReadyError ||
    error instanceof EnablementMovedError ||
    isCorrelationKeyConflict(error)
  )
    return "not_ready";
  if (error instanceof WorkflowRevisionUnavailableError)
    return error.kind === "retry" ? "retry" : "refused";
  if (
    error instanceof EnvironmentCapacityError ||
    error instanceof EnvironmentBindingUnavailableError ||
    error instanceof TenantActiveRunLimitError ||
    error instanceof ExecutionAllocationConflictError
  )
    return "room";
  if (
    error instanceof AccessDeniedError ||
    error instanceof WorkflowEnablementSuspendedError ||
    error instanceof WorkflowEnablementNotFoundError ||
    error instanceof WorkflowNotFoundError ||
    error instanceof RunEnrollmentConflictError ||
    error instanceof RunInputInvalidError ||
    error instanceof ProductionDeploymentNotFoundError ||
    error instanceof ProjectNotFoundError ||
    error instanceof EnvironmentNotFoundError ||
    error instanceof EnvironmentAccessDeniedError ||
    error instanceof EnvironmentIncompatibleError ||
    error instanceof EnvironmentPolicyInvalidError ||
    error instanceof NoCompatibleEnvironmentError ||
    error instanceof AuthenticationRequiredError ||
    error instanceof ConnectionPermissionDeniedError ||
    error instanceof ConnectionNotFoundError ||
    error instanceof PluginSecretsMissingError ||
    error instanceof SandboxProviderNotConfiguredError
  )
    return "refused";
  return "retry";
}

export class RunQueueFullError extends Error {
  constructor(
    readonly workflowName: string,
    readonly correlationKey: string,
  ) {
    super(
      `Workflow '${workflowName}' already has ${MAX_QUEUED_RUNS_PER_KEY} runs queued for correlation key '${correlationKey}'`,
    );
    this.name = "RunQueueFullError";
  }
}

/** A queued run is not the next to start, or no longer queued. */
class QueuedRunNotReadyError extends Error {
  constructor(readonly runId: string) {
    super(`Queued run '${runId}' cannot start yet`);
    this.name = "QueuedRunNotReadyError";
  }
}

/**
 * The enablement moved (a following revision, an update) between reading
 * it and starting the run. A run started by a caller is refused; a queued
 * run starts again at the new revision.
 */
class EnablementMovedError extends AccessDeniedError {
  constructor() {
    super("The automation moved to another revision while the run started");
    this.name = "EnablementMovedError";
  }
}

export class ProductionDeploymentNotFoundError extends Error {
  constructor(readonly projectId: string) {
    super(`Project '${projectId}' has no deployed main revision`);
    this.name = "ProductionDeploymentNotFoundError";
  }
}

export class RunInputInvalidError extends Error {
  constructor(
    readonly workflowName: string,
    readonly errors: string[],
  ) {
    super(
      `Input for workflow '${workflowName}' is invalid: ${errors.join("; ")}`,
    );
    this.name = "RunInputInvalidError";
  }
}

function requireCorrelationKey(value: string): string {
  if (value.length === 0 || value.length > 500) {
    throw new Error("correlationKey must contain between 1 and 500 characters");
  }
  return value;
}

function requireDeliveryKey(value: string): string {
  if (value.length === 0 || value.length > 500) {
    throw new Error("deliveryKey must contain between 1 and 500 characters");
  }
  return value;
}

/**
 * The subject a run's input names at a declared dot path (ADR 0325): a
 * string of 1 to 500 characters or a finite number. Anything else, or
 * nothing there, leaves the run unkeyed.
 */
export function correlationKeyAtPath(
  input: unknown,
  path: string,
): string | undefined {
  let value: unknown = input;
  for (const segment of path.split(".")) {
    if (typeof value !== "object" || value === null) return undefined;
    value = Array.isArray(value)
      ? /^\d+$/.test(segment)
        ? value[Number(segment)]
        : undefined
      : Object.hasOwn(value, segment)
        ? Reflect.get(value, segment)
        : undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && value.length > 0 && value.length <= 500)
    return value;
  return undefined;
}

/**
 * The values at a workflow's `coalesce` paths (ADR 0337), exactly: a
 * missing one apart from null, and booleans, objects and long strings as
 * themselves, so runs whose values differ never compare equal.
 */
export function coalesceValuesAtPaths(
  input: unknown,
  paths: readonly string[],
): Json {
  return paths.map((path) => {
    let value: unknown = input;
    for (const segment of path.split(".")) {
      if (typeof value !== "object" || value === null) return ["missing"];
      value = Array.isArray(value)
        ? /^\d+$/.test(segment)
          ? value[Number(segment)]
          : undefined
        : Object.hasOwn(value, segment)
          ? Reflect.get(value, segment)
          : undefined;
    }
    return value === undefined ? ["missing"] : ["value", toJson(value)];
  });
}

/**
 * What makes a queued run alike another (ADR 0337), as a digest: its
 * coalesce values, and everything a run runs as, so only runs that would
 * do the same thing join: the program and session artifact, the
 * Environment, the owner and their scopes, and the enablement.
 */
function coalesceKeyOf(facts: Json): string {
  return createHash("sha256").update(JSON.stringify(facts)).digest("hex");
}

/** What starting a queued run needs beyond the run row (ADR 0325). */
interface QueuedEnrollment {
  environment?: string;
  unattended?: boolean;
  enablementId?: string;
  commitSha?: string;
  /**
   * It runs at `commitSha`, a revision its enablement has not moved to yet
   * (a project's deploy workflow, ADR 0331), not where the enablement is.
   */
  atRevision?: true;
  remoteBranch?: string;
  /** The enrolling identity's narrowing; absent for the host root. */
  owner?: OwnerNarrowing;
}

/** What a scoped identity may reach, as it enrolled a queued run. */
type OwnerNarrowing = Pick<
  Identity,
  "scope" | "executionScope" | "connectionScope" | "projectPermissions"
>;

function ownerNarrowing(identity: Identity): OwnerNarrowing | undefined {
  if (identity.scope === undefined) return undefined;
  return {
    scope: identity.scope,
    ...(identity.executionScope
      ? { executionScope: identity.executionScope }
      : {}),
    ...(identity.connectionScope
      ? { connectionScope: identity.connectionScope }
      : {}),
    ...(identity.projectPermissions
      ? { projectPermissions: identity.projectPermissions }
      : {}),
  };
}

/**
 * Who starts a queued run that has no enablement (ADR 0325): the host root
 * as it was; the project principal as it enrolled (host-issued, never a
 * membership); a member as they are now, narrowed to what the enrolling
 * identity held (an app guest, an agent's narrower scopes). Null when the
 * member may no longer act.
 */
export function queuedRunOwner(input: {
  tenantId: string;
  externalUserId: string;
  owner: OwnerNarrowing | undefined;
  live: Identity | null | undefined;
}): Identity | null {
  const { tenantId, externalUserId, owner, live } = input;
  if (!owner) return { tenantId, externalUserId };
  if (isProjectPrincipal(externalUserId))
    return { tenantId, externalUserId, ...owner };
  if (
    !live ||
    live.tenantId !== tenantId ||
    live.externalUserId !== externalUserId
  )
    return null;
  return {
    ...live,
    scope: intersectScope(owner.scope ?? [], live),
    // A scoped identity without Environments or connections had none, so
    // the member's own never reach the run it queued.
    executionScope: (owner.executionScope ?? []).filter((ref) =>
      identityMayUseEnvironment(live, ref.projectId, ref.name),
    ),
    connectionScope: (owner.connectionScope ?? []).filter((ref) =>
      identityMayUseConnection(live, ref.projectId, ref.environment, ref.alias),
    ),
    projectPermissions: intersectProjectPermissions(
      owner.projectPermissions ?? [],
      live,
    ),
  };
}

function queuedEnrollment(value: unknown): QueuedEnrollment {
  const record = jsonRecord(value);
  const text = (field: string) =>
    typeof record[field] === "string" ? (record[field] as string) : undefined;
  const environment = text("environment");
  const enablementId = text("enablementId");
  const commitSha = text("commitSha");
  const remoteBranch = text("remoteBranch");
  const owner = jsonRecord(record.owner);
  return {
    ...(environment ? { environment } : {}),
    ...(record.unattended === true ? { unattended: true } : {}),
    ...(enablementId ? { enablementId } : {}),
    ...(commitSha ? { commitSha } : {}),
    ...(record.atRevision === true ? { atRevision: true as const } : {}),
    ...(remoteBranch ? { remoteBranch } : {}),
    // Written by this service from an Identity (as enablements store theirs).
    ...(Array.isArray(owner.scope)
      ? { owner: owner as unknown as OwnerNarrowing }
      : {}),
  };
}

/** Serializes enrollment and start for one key within a transaction. */
async function lockCorrelationKey(args: {
  trx: Transaction<DB>;
  projectId: string;
  workflowName: string;
  correlationKey: string;
}): Promise<void> {
  const name = `${args.projectId}\u0000${args.workflowName}\u0000${args.correlationKey}`;
  await sql`select pg_advisory_xact_lock(hashtextextended(${name}, 325))`.execute(
    args.trx,
  );
}

type EnrollmentDecision =
  | { kind: "proceed" }
  | { kind: "existing"; run: Run }
  | { kind: "restart"; runId: string }
  | { kind: "queue" };

/** The delivery uniqueness violation: another enrollment took this delivery. */
function isDeliveryKeyConflict(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const record = error as { code?: unknown; constraint?: unknown };
  return (
    record.code === "23505" && record.constraint === "uq_workflow_runs_delivery"
  );
}

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
  privateSource?: (input: {
    identity: Identity;
    projectId: string;
    commitSha: string;
  }) => Promise<Record<string, string> | null>;
  appPolicies?: AppPoliciesService;
  projectManager: ProjectManager;
  sandboxProvider?: SandboxProvider;
  devSandboxes?: DevSandboxService;
  runPluginsLoader?: RunPluginsLoader;
  deploymentArtifacts: DeploymentArtifactsService;
  deploymentRuntime?: DeploymentRuntimeService;
  deploymentRuntimeOptions?: {
    maxConcurrency?: number;
    autoStopMinutes?: number;
  };
  executionJobs: ExecutionJobsService;
  executionEnvironments: ExecutionEnvironmentsService;
  executionAllocations: ExecutionAllocationsService;
  connectionAdmission?: ConnectionAdmissionService;
  executionWorker: ExecutionWorkerService;
  runtimeEvents: RuntimeEventsService;
  coordinator: RunCoordinator;
  tenantPolicies: TenantPoliciesService;
  workflowEnablements?: () => WorkflowEnablementsService;
  /**
   * A member's identity as the host resolves it now, or null when they may
   * no longer act: starting a member's queued run uses it (ADR 0325).
   */
  resolveOwner?: (args: {
    tenantId: string;
    projectId: string;
    externalUserId: string;
  }) => Promise<Identity | null>;
  /** Whether the host dispatches this trigger kind alone (ADR 0327). */
  hostOnlyKind?: (kind: string) => boolean;
}

interface PreparedSource {
  files: Record<string, string>;
  workflowFile: string;
  graph: WorkflowGraph;
  /** The run secrets the project declares, which every run receives. */
  secretNames: string[];
  commitSha: string | null;
  workflowPackage?: WorkflowPackagePayload;
}

const tracer = getTracer("@catamorphic/core");

const DEFAULT_CALL_BUDGET_MS = 30_000;
const MAX_CALL_BUDGET_MS = 300_000;
const SYNC_LEASE_SECONDS = 60;
/** Poll cadence while another worker holds the run's current job. */
const SYNC_POLL_MS = 50;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class RunsService {
  /** Replica memory (b): sizes of the prepared sources below. */
  private readonly preparedSourceBytes = new Map<string, number>();
  /** Replica memory (b): prepared sources keyed by commit sha. */
  private readonly preparedSources = new Map<string, Promise<PreparedSource>>();

  constructor(
    private readonly db: Kysely<DB>,
    private readonly deps: RunsServiceDeps,
  ) {}

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
      // Uniform denial for scoped identities: a 404-for-missing /
      // 403-for-denied split would let a viewer probe which run ids exist.
      if (args.identity.scope) throw new AccessDeniedError();
      throw new RunNotFoundError(args.runId);
    }
    await this.assertRunAccess(args.identity, row);
    const [pause, connectionActionRequired, batches, steps, attempts] =
      await Promise.all([
        this.db
          .selectFrom("workflow_pauses")
          .where("run_id", "=", args.runId)
          .where("status", "=", "open")
          .selectAll()
          .executeTakeFirst(),
        this.db
          .selectFrom("connection_action_requirements")
          .where("workflow_run_id", "=", args.runId)
          .where("status", "=", "pending")
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
        connectionActionRequired,
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

  /** Caller-authorized identity of the immutable retained source this run uses. */
  async retainedSource(input: { identity: Identity; runId: string }): Promise<{
    artifactId: string;
    revision: number;
    lifetime: "member" | "session";
  } | null> {
    await this.assertRunPermission(input.identity, input.runId, "runs:read");
    const row = await this.db
      .selectFrom("workflow_runs as run")
      .innerJoin("projects", "projects.id", "run.project_id")
      .leftJoin(
        "deployment_artifacts as deployment",
        "deployment.id",
        "run.deployment_artifact_id",
      )
      .leftJoin(
        "session_artifacts as source",
        "source.id",
        "run.session_artifact_id",
      )
      .leftJoin("session_artifact_revisions as revision", (join) =>
        join
          .onRef("revision.artifact_id", "=", "source.id")
          .onRef("revision.commit_sha", "=", "deployment.commit_sha"),
      )
      .where("run.id", "=", input.runId)
      .where("projects.tenant_id", "=", input.identity.tenantId)
      .select([
        "run.session_artifact_id",
        "source.lifetime",
        "revision.source_revision",
      ])
      .executeTakeFirst();
    if (!row) throw new AccessDeniedError();
    if (!row.session_artifact_id) return null;
    if (
      row.source_revision === null ||
      (row.lifetime !== "member" && row.lifetime !== "session")
    )
      throw new AccessDeniedError("Retained source revision is unavailable");
    return {
      artifactId: row.session_artifact_id,
      revision: row.source_revision,
      lifetime: row.lifetime,
    };
  }

  async listItems(args: ListBatchItemsInput): Promise<ListBatchItemsResult> {
    await this.assertRunPermission(args.identity, args.runId, "runs:read");
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
    await this.assertRunPermission(args.identity, args.runId, "runs:read");
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
    const scoped = await resolveScope({
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
    const appNames = (args.identity.scope ?? [])
      .filter((ref) => ref.projectId === args.projectId && ref.kind === "app")
      .map((ref) => ("name" in ref ? ref.name : ""));
    const agentIds = (args.identity.scope ?? [])
      .filter((ref) => ref.projectId === args.projectId && ref.kind === "agent")
      .map((ref) =>
        "name" in ref ? `project:${args.projectId}:${ref.name}` : "",
      );
    const retainedAudience = this.db
      .selectFrom("session_artifacts as source")
      .leftJoin("agent_sessions as session", "session.id", "source.session_id")
      .where("source.project_id", "=", args.projectId)
      .where("source.owner_external_user_id", "=", args.identity.externalUserId)
      .where(({ or, eb }) =>
        or([
          eb("source.lifetime", "=", "member"),
          eb.val(
            hasProjectPermission(args.identity, args.projectId, "runs:read"),
          ),
          ...(appNames.length
            ? [
                sql<boolean>`('session-' || source.id::text) in (${sql.join(appNames)})`,
              ]
            : []),
          ...(agentIds.length ? [eb("session.agent_id", "in", agentIds)] : []),
        ]),
      )
      .select("source.id");
    query = query.where(({ or, eb }) =>
      or([
        eb("session_artifact_id", "is", null),
        eb("session_artifact_id", "in", retainedAudience),
      ]),
    );
    countQuery = countQuery.where(({ or, eb }) =>
      or([
        eb("session_artifact_id", "is", null),
        eb("session_artifact_id", "in", retainedAudience),
      ]),
    );
    if (scoped) {
      // Scoped identities see only runs of the workflows their scope resolves to —
      // the read-side mirror of the trigger gate (ADR 0036).
      if (
        args.workflowName &&
        !scoped.allowedWorkflows.has(args.workflowName)
      ) {
        throw new AccessDeniedError();
      }
      const frozen = [...scoped.allowedWorkflows];
      if (frozen.length === 0) return { items: [], total: 0 };
      query = query.where("workflow_name", "in", frozen);
      countQuery = countQuery.where("workflow_name", "in", frozen);
      if (scoped.sessionApp) {
        const appScope = JSON.stringify([
          {
            kind: "app",
            projectId: args.projectId,
            name: scoped.sessionApp.name,
          },
        ]);
        query = query.where(sql<boolean>`caller_scope @> ${appScope}::jsonb`);
        countQuery = countQuery.where(
          sql<boolean>`caller_scope @> ${appScope}::jsonb`,
        );
      }
    }
    if (args.workflowName) {
      query = query.where("workflow_name", "=", args.workflowName);
      countQuery = countQuery.where("workflow_name", "=", args.workflowName);
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
    const [pauses, connectionActionRequirements, batches] =
      runIds.length === 0
        ? [[], [], []]
        : await Promise.all([
            this.db
              .selectFrom("workflow_pauses")
              .where("run_id", "in", runIds)
              .where("status", "=", "open")
              .selectAll()
              .execute(),
            this.db
              .selectFrom("connection_action_requirements")
              .where("workflow_run_id", "in", runIds)
              .where("status", "=", "pending")
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
          connectionActionRequired: connectionActionRequirements.find(
            (requirement) => requirement.workflow_run_id === row.id,
          ),
          batchScopes: batchesByRun.get(row.id) ?? [],
        }),
      ),
      total: Number(count.count),
    };
  }

  async triggerProduction(
    args: TriggerProductionRunInput,
    dispatch?: HostDispatch,
  ): Promise<Run> {
    return this.trigger(args, dispatchFacts(dispatch));
  }

  /** Check the requesting caller before dispatch switches to a consented owner. */
  async assertTriggerAccess(args: {
    identity: Identity;
    projectId: string;
    workflowName: string;
    commitSha?: string;
  }): Promise<void> {
    assertTokenScope(args.identity, "sessions:run");
    await this.requireProject(args.identity, args.projectId);
    await assertScopeAllowsWorkflow({
      ...args,
      db: this.db,
      policies: this.deps.appPolicies,
    });
    await this.assertRetainedSourceAccess(args);
  }

  /** Run an immutable non-production commit, used by temporary watchers. */
  async triggerAtCommit(
    args: TriggerPinnedRunInput,
    dispatch?: HostDispatch,
  ): Promise<Run> {
    return this.trigger(args, dispatchFacts(dispatch));
  }

  /** Trigger-only entry point for an immutable non-production commit. */
  async triggerUnattendedAtCommit(
    args: TriggerPinnedRunInput & {
      connectionAuthorizationSnapshot?: readonly ResolvedConnectionBinding[];
    },
  ): Promise<Run> {
    return this.trigger({ ...args, unattended: true });
  }

  /** Trigger-only entry point. It accepts service connections only. */
  async triggerUnattendedProduction(
    args: TriggerProductionRunInput & {
      connectionAuthorizationSnapshot?: readonly ResolvedConnectionBinding[];
    },
  ): Promise<Run> {
    return this.trigger({ ...args, unattended: true });
  }

  /** Enroll unattended work under an explicitly consented owner. */
  async triggerWithEnablement(
    args: TriggerProductionRunInput & {
      enablementId: string;
      expected?: Pick<
        WorkflowEnablement,
        "commitSha" | "consentDigest" | "revision"
      >;
    },
    dispatch?: HostDispatch,
  ): Promise<Run> {
    return this.triggerEnabled(args, dispatchFacts(dispatch));
  }

  private async triggerEnabled(
    args: TriggerProductionRunInput & {
      enablementId: string;
      expected?: Pick<
        WorkflowEnablement,
        "commitSha" | "consentDigest" | "revision"
      >;
    },
    internal: RunInternalFacts,
  ): Promise<Run> {
    const service = this.deps.workflowEnablements?.();
    if (!service) throw new Error("Workflow enablements are not configured");
    const validated = await service.revalidate({
      identity: args.identity,
      enablementId: args.enablementId,
    });
    const enablement = validated.enablement;
    if (
      args.expected &&
      (enablement.commitSha !== args.expected.commitSha ||
        enablement.consentDigest !== args.expected.consentDigest ||
        enablement.revision !== args.expected.revision)
    )
      throw new AccessDeniedError();
    if (
      enablement.projectId !== args.projectId ||
      enablement.workflowName !== args.workflowName
    ) {
      throw new Error(
        "Workflow enablement does not match the requested workflow",
      );
    }
    return this.trigger(
      {
        ...args,
        identity: validated.ownerIdentity,
        environment: enablement.environment,
        commitSha: enablement.commitSha,
        remoteBranch: enablement.remoteBranch,
        connectionAuthorizationSnapshot: enablement.connections,
        workflowEnablementId: enablement.id,
        enablementSnapshot: {
          commitSha: enablement.commitSha,
          consentDigest: enablement.consentDigest,
          revision: enablement.revision,
        },
        unattended: true,
      },
      internal,
    );
  }

  /**
   * Run an enablement at a later published commit, under the authority it
   * was consented to, before it moves there (ADR 0331): the project's
   * deploy workflow. Refused when that commit needs new consent or its
   * workflow does not build.
   */
  async triggerWithEnablementAtRevision(
    args: TriggerProductionRunInput & {
      enablementId: string;
      commitSha: string;
    },
  ): Promise<Run> {
    const service = this.deps.workflowEnablements?.();
    if (!service) throw new Error("Workflow enablements are not configured");
    const validated = await service.revalidate({
      identity: args.identity,
      enablementId: args.enablementId,
    });
    const enablement = validated.enablement;
    if (
      enablement.projectId !== args.projectId ||
      enablement.workflowName !== args.workflowName
    )
      throw new Error(
        "Workflow enablement does not match the requested workflow",
      );
    const ready = await service.previewAtRevision({
      enablementId: enablement.id,
      commitSha: args.commitSha,
    });
    if (ready.kind !== "ready")
      throw new WorkflowRevisionUnavailableError(ready.reason, ready.kind);
    return this.trigger({
      ...args,
      identity: validated.ownerIdentity,
      environment: enablement.environment,
      commitSha: ready.preview.commitSha,
      remoteBranch: enablement.remoteBranch,
      connectionAuthorizationSnapshot: enablement.connections,
      workflowEnablementId: enablement.id,
      enablementSnapshot: {
        commitSha: enablement.commitSha,
        consentDigest: enablement.consentDigest,
        revision: enablement.revision,
      },
      unattended: true,
      atRevision: true,
    });
  }

  /**
   * Triggers a run and drives it inline until it settles or would wait: the
   * request-path shape of execution. Same authorization, same durable run
   * record, same immutable deployed commit as `triggerProduction` — sync is a
   * calling mode, not a workflow kind (ADR 0040, 0053). A workflow that never
   * suspends settles in the call; one that does returns `suspended` with the
   * run id and the polling workers finish it.
   */
  async call(args: CallRunInput): Promise<RunCallOutcome> {
    const budgetMs = Math.min(
      Math.max(1_000, args.budgetMs ?? DEFAULT_CALL_BUDGET_MS),
      MAX_CALL_BUDGET_MS,
    );
    const run = await this.trigger(args);
    return this.driveInline({
      tenantId: args.identity.tenantId,
      runId: run.id,
      deadline: Date.now() + budgetMs,
    });
  }

  /**
   * Runs a run's queue jobs inline until it settles or would wait. Detaching
   * is always just "stop claiming": the next job stays pending and the
   * polling workers continue the run asynchronously. Callers must already
   * be authorized for the run (this reads run rows by id).
   */
  async driveInline(args: {
    tenantId: string;
    runId: string;
    deadline: number;
  }): Promise<RunCallOutcome> {
    const workerId = `sync-call:${crypto.randomUUID()}`;
    const controller = new AbortController();
    const abortTimer = setTimeout(
      () => controller.abort(),
      Math.max(0, args.deadline - Date.now()),
    );
    const suspended = (suspendedOn: RunSuspensionReason): RunCallOutcome => ({
      status: "suspended",
      runId: args.runId,
      suspendedOn,
    });
    try {
      for (;;) {
        const run = await this.db
          .selectFrom("workflow_runs")
          .select(["status", "phase", "result", "error"])
          .where("id", "=", args.runId)
          .executeTakeFirst();
        if (!run) {
          return {
            status: "failed",
            runId: args.runId,
            error: "Run disappeared while executing",
          };
        }
        if (run.status === "completed") {
          return {
            status: "completed",
            runId: args.runId,
            output: (run.result ?? null) as Json,
          };
        }
        if (run.status === "failed" || run.status === "canceled") {
          return {
            status: "failed",
            runId: args.runId,
            error: run.error ?? `Run ${run.status}`,
          };
        }
        if (run.status === "waiting") {
          return suspended(run.phase === "pause" ? "pause" : "child");
        }
        if (run.status === "paused" || run.status === "canceling") {
          return suspended("paused");
        }
        if (run.status === "queued") return suspended("queue");
        if (Date.now() >= args.deadline) return suspended("budget");

        const job = await this.deps.executionJobs.nextForRun({
          tenantId: args.tenantId,
          runId: args.runId,
        });
        if (!job) {
          // The run is live but jobless: a transition is committing on
          // another connection. Bounded by the deadline check above.
          await delay(SYNC_POLL_MS);
          continue;
        }
        if (job.status === "running") {
          // A polling worker beat us to the claim; wait for its outcome.
          await delay(SYNC_POLL_MS);
          continue;
        }
        if (job.kind !== "durable_boundary") return suspended("batch");
        if (!job.due) return suspended("backoff");
        const claimedAt = performance.now();
        const claimed = await this.deps.executionJobs.claimById({
          jobId: job.id,
          workerId,
          leaseSeconds: SYNC_LEASE_SECONDS,
        });
        if (!claimed) continue;
        await this.deps.executionWorker.runClaimedJob({
          job: claimed,
          workerId,
          leaseSeconds: SYNC_LEASE_SECONDS,
          claimedAt,
          signal: controller.signal,
        });
        // Every disposition — completed, deferred, failed, lease lost — is
        // reflected in the run/job rows the next iteration reads.
      }
    } finally {
      clearTimeout(abortTimer);
    }
  }

  async cancel(args: CancelRunInput): Promise<Run> {
    return withSpan(
      {
        tracer,
        name: "workflow.cancel",
        attributes: {
          "catamorphic.run.id": args.runId,
          "catamorphic.tenant.id": args.identity.tenantId,
          "user.id": args.identity.externalUserId,
        },
      },
      async () => {
        await this.assertRunPermission(args.identity, args.runId, "runs:write");
        const run = await this.get(args);
        const allocationRuntime = run.allocationId
          ? await this.runtimeForAllocation({
              identity: args.identity,
              allocationId: run.allocationId,
            }).catch(() => undefined)
          : undefined;
        const invocations = await this.deps.coordinator.cancel(args);
        const deploymentRuntime =
          allocationRuntime?.runtime ?? this.deps.deploymentRuntime;
        await Promise.all(
          invocations.map((invocation) =>
            deploymentRuntime?.cancel(invocation).catch(() => {}),
          ),
        );
        // A canceled run, queued or active, frees its key for the next.
        await this.startQueuedRuns({ runId: args.runId }).catch(() => {});
        return this.get(args);
      },
    );
  }

  async pause(args: PauseRunInput): Promise<Run> {
    return withSpan(
      {
        tracer,
        name: "workflow.pause",
        attributes: {
          "catamorphic.run.id": args.runId,
          "catamorphic.tenant.id": args.identity.tenantId,
          "user.id": args.identity.externalUserId,
        },
      },
      async () => {
        await this.assertRunPermission(args.identity, args.runId, "runs:write");
        const outcome = await this.deps.coordinator.pauseOperator(args);
        if (outcome === "unavailable") {
          throw new RunCapabilityError("pauseProcessing", "pause");
        }
        return this.get(args);
      },
    );
  }

  async resume(args: ResumeRunInput): Promise<Run> {
    return withSpan(
      {
        tracer,
        name: "workflow.resume",
        attributes: {
          "catamorphic.run.id": args.runId,
          "catamorphic.tenant.id": args.identity.tenantId,
          "user.id": args.identity.externalUserId,
        },
      },
      async () => {
        await this.assertRunPermission(args.identity, args.runId, "runs:write");
        const outcome = await this.deps.coordinator.resumeOperator(args);
        if (outcome === "unavailable") {
          throw new RunCapabilityError("resumeProcessing", "resume");
        }
        return this.get(args);
      },
    );
  }

  async resumePause(args: ResumeRunPauseInput): Promise<Run> {
    return withSpan(
      {
        tracer,
        name: "workflow.resume_pause",
        attributes: {
          "catamorphic.run.id": args.runId,
          "catamorphic.tenant.id": args.identity.tenantId,
          "user.id": args.identity.externalUserId,
        },
      },
      async () => {
        await this.assertRunPermission(args.identity, args.runId, "runs:write");
        await this.deps.coordinator.resumePause(args);
        return this.get(args);
      },
    );
  }

  /** Buffer or deliver a named callback to the explicitly addressed generation. */
  async signalByKey(args: SignalRunInput): Promise<RunSignalReceipt> {
    return withSpan(
      {
        tracer,
        name: "workflow.signal",
        attributes: {
          "catamorphic.run.id": args.runId,
          "catamorphic.tenant.id": args.identity.tenantId,
          "user.id": args.identity.externalUserId,
        },
      },
      async () => {
        assertProjectPermission(args.identity, args.projectId, "runs:write");
        await this.requireProject(args.identity, args.projectId);
        await this.assertRunPermission(args.identity, args.runId, "runs:write");
        return this.deps.coordinator.signalByKey(args);
      },
    );
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
    assertProjectPermission(args.identity, args.projectId, "runs:write");
    const run = await this.findActiveByKey(args);
    if (!run) return null;
    return this.cancel({
      identity: args.identity,
      runId: run.id,
      ...(args.reason === undefined ? {} : { reason: args.reason }),
    });
  }

  /**
   * Start the next queued run of each key whose runs ahead have all settled
   * (ADR 0325). With `runId` (a run whose job just settled), its root's key,
   * and, once that root has settled, heads waiting for the room it freed;
   * with a key, only that key; otherwise a fair page of due heads across
   * tenants and keys, the worker's maintenance sweep. Any replica may call
   * it: the start transaction rechecks the head under the key's lock, and
   * the active-key index stays the authority.
   */
  async startQueuedRuns(
    args: {
      runId?: string;
      projectId?: string;
      workflowName?: string;
      correlationKey?: string;
      limit?: number;
    } = {},
  ): Promise<void> {
    if (args.runId) {
      // A child's job can settle its root; the root's key is the one freed.
      const root = await sql<{
        tenant_id: string;
        project_id: string;
        workflow_name: string;
        correlation_key: string | null;
        status: string;
      }>`
        WITH RECURSIVE up AS (
          SELECT id, parent_run_id, 0 AS depth FROM workflow_runs WHERE id = ${args.runId}
          UNION ALL
          SELECT parent.id, parent.parent_run_id, up.depth + 1
          FROM workflow_runs AS parent JOIN up ON parent.id = up.parent_run_id
          WHERE up.depth < 64
        )
        SELECT projects.tenant_id, run.project_id, run.workflow_name,
               run.correlation_key, run.status
        FROM up
        JOIN workflow_runs AS run ON run.id = up.id
        JOIN projects ON projects.id = run.project_id
        WHERE up.parent_run_id IS NULL
      `.execute(this.db);
      const settled = root.rows[0];
      if (!settled) return;
      if (settled.correlation_key)
        await this.startQueuedHeads({
          key: {
            projectId: settled.project_id,
            workflowName: settled.workflow_name,
            correlationKey: settled.correlation_key,
          },
        });
      // A settled root gave its room back: heads that waited for room
      // try now, without waiting out their backoff.
      if (["completed", "failed", "canceled"].includes(settled.status))
        await this.startQueuedHeads({
          tenantId: settled.tenant_id,
          waitingForRoom: true,
          limit: 5,
        });
      return;
    }
    await this.startQueuedHeads({
      ...(args.projectId && args.workflowName && args.correlationKey
        ? {
            key: {
              projectId: args.projectId,
              workflowName: args.workflowName,
              correlationKey: args.correlationKey,
            },
          }
        : {}),
      ...(args.limit ? { limit: args.limit } : {}),
    });
  }

  private async startQueuedHeads(args: {
    key?: { projectId: string; workflowName: string; correlationKey: string };
    tenantId?: string;
    /** Only heads that last waited for room, due or not. */
    waitingForRoom?: boolean;
    limit?: number;
  }): Promise<void> {
    const limit = args.limit ?? 20;
    // A head that cannot start (its owner lost access) fails and frees its
    // key, so a key's next head is tried at once, a bounded number of times.
    for (let round = 0; round < (args.key ? 10 : 3); round += 1) {
      const key = args.key;
      const heads = await sql<QueuedHead>`
        WITH heads AS (
          SELECT queued.id, queued.project_id, queued.workflow_name,
                 queued.correlation_key, queued.external_user_id,
                 queued.caller_scope, queued.input, queued.enrollment,
                 queued.queue_attempts, queued.queued_at,
                 queued.queue_attempted_at, projects.tenant_id,
                 row_number() OVER (
                   PARTITION BY projects.tenant_id
                   ORDER BY queued.queue_attempted_at NULLS FIRST, queued.queued_at, queued.id
                 ) AS tenant_rank
          FROM workflow_runs AS queued
          JOIN projects ON projects.id = queued.project_id
          WHERE queued.status = 'queued'
            ${key ? sql`AND queued.project_id = ${key.projectId} AND queued.workflow_name = ${key.workflowName} AND queued.correlation_key = ${key.correlationKey}` : sql``}
            ${args.tenantId ? sql`AND projects.tenant_id = ${args.tenantId}` : sql``}
            ${
              args.waitingForRoom
                ? sql`AND queued.queue_blocked = 'room'`
                : key
                  ? sql``
                  : // Room comes back with teardown as well as with settling
                    // runs: retry it every 5 seconds more, up to 30. Errors
                    // back off exponentially, up to 5 minutes.
                    sql`AND (queued.queue_attempted_at IS NULL OR queued.queue_attempted_at
                      + make_interval(secs => CASE WHEN queued.queue_blocked = 'room'
                          THEN least(30, 5 * queued.queue_room_waits)
                          ELSE least(300, 5 * power(2, least(queued.queue_attempts, 6))) END) <= now())`
            }
            AND NOT EXISTS (
              SELECT 1 FROM workflow_runs AS ahead
              WHERE ahead.project_id = queued.project_id
                AND ahead.workflow_name = queued.workflow_name
                AND ahead.correlation_key = queued.correlation_key
                AND ahead.id <> queued.id
                AND (ahead.status NOT IN ('queued', 'completed', 'failed', 'canceled')
                  OR (ahead.status = 'queued'
                    AND (ahead.queued_at, ahead.id) < (queued.queued_at, queued.id)))
            )
        )
        SELECT * FROM heads
        -- Each tenant's few oldest first, then deeper: one tenant's blocked
        -- heads never fill the page.
        WHERE tenant_rank <= ${Math.max(1, Math.ceil(limit / 4))}
        ORDER BY tenant_rank, queue_attempted_at NULLS FIRST, queued_at, id
        LIMIT ${limit}
      `.execute(this.db);
      if (heads.rows.length === 0) return;
      let failed = false;
      for (const head of heads.rows) {
        if ((await this.startQueuedRun(head)) === "failed") failed = true;
      }
      if (!failed) return;
    }
  }

  private async startQueuedRun(
    head: QueuedHead,
  ): Promise<"started" | "waiting" | "failed"> {
    return withSpan(
      {
        tracer,
        name: "workflow.run.start_queued",
        attributes: {
          "catamorphic.run.id": head.id,
          "catamorphic.project.id": head.project_id,
          "catamorphic.workflow.name": head.workflow_name,
          "catamorphic.tenant.id": head.tenant_id,
        },
      },
      async (span) => {
        const enrollment = queuedEnrollment(head.enrollment);
        const mechanics: Identity = {
          tenantId: head.tenant_id,
          externalUserId: head.external_user_id ?? "",
        };
        const common = {
          projectId: head.project_id,
          workflowName: head.workflow_name,
          input: head.input ?? null,
          correlationKey: head.correlation_key ?? "",
          onConflict: "queue" as const,
          start: { runId: head.id },
        };
        try {
          if (enrollment.enablementId) {
            const service = this.deps.workflowEnablements?.();
            if (!service)
              throw new Error("Workflow enablements are not configured");
            const enablementId = enrollment.enablementId;
            // The automation's current consent starts it, at the commit the
            // enablement holds now: nothing of a queued run has run yet. A
            // revision landing meanwhile moves it, and it starts there.
            for (let attempt = 1; ; attempt++) {
              const { enablement, ownerIdentity } = await service.revalidate({
                identity: mechanics,
                enablementId,
              });
              // A run queued at a later revision (the project's deploy
              // workflow, ADR 0331) runs there, under the consent it holds.
              let commitSha = enablement.commitSha;
              if (
                enrollment.atRevision &&
                enrollment.commitSha &&
                enrollment.commitSha !== enablement.commitSha
              ) {
                const ready = await service.previewAtRevision({
                  enablementId,
                  commitSha: enrollment.commitSha,
                });
                if (ready.kind !== "ready")
                  throw new WorkflowRevisionUnavailableError(
                    ready.reason,
                    ready.kind,
                  );
                commitSha = ready.preview.commitSha;
              }
              try {
                await this.triggerInner({
                  ...common,
                  identity: ownerIdentity,
                  environment: enablement.environment,
                  commitSha,
                  remoteBranch: enablement.remoteBranch,
                  connectionAuthorizationSnapshot: enablement.connections,
                  workflowEnablementId: enablement.id,
                  enablementSnapshot: {
                    commitSha: enablement.commitSha,
                    consentDigest: enablement.consentDigest,
                    revision: enablement.revision,
                  },
                  unattended: true,
                  ...(enrollment.atRevision
                    ? { atRevision: true as const }
                    : {}),
                });
                break;
              } catch (error) {
                if (!(error instanceof EnablementMovedError) || attempt >= 3)
                  throw error;
              }
            }
          } else {
            const member =
              enrollment.owner && !isProjectPrincipal(mechanics.externalUserId);
            const identity = queuedRunOwner({
              ...mechanics,
              owner: enrollment.owner,
              live: member
                ? await this.deps.resolveOwner?.({
                    tenantId: head.tenant_id,
                    projectId: head.project_id,
                    externalUserId: mechanics.externalUserId,
                  })
                : undefined,
            });
            if (!identity) throw new AccessDeniedError();
            await this.triggerInner({
              ...common,
              identity,
              ...(enrollment.environment
                ? { environment: enrollment.environment }
                : {}),
              ...(enrollment.commitSha
                ? { commitSha: enrollment.commitSha }
                : {}),
              ...(enrollment.remoteBranch
                ? { remoteBranch: enrollment.remoteBranch }
                : {}),
              ...(enrollment.unattended ? { unattended: true } : {}),
            });
          }
          span.setAttribute("catamorphic.run.queue.outcome", "started");
          return "started";
        } catch (error) {
          const outcome = queuedStartOutcome(error);
          span.setAttribute("catamorphic.run.queue.outcome", outcome);
          if (outcome === "not_ready") return "waiting";
          const message =
            error instanceof Error ? error.message : String(error);
          // Database or transport trouble retries with backoff, a bounded
          // number of times; room retries for as long as the run is queued.
          if (
            outcome === "refused" ||
            (outcome === "retry" &&
              head.queue_attempts + 1 >= MAX_QUEUED_START_ATTEMPTS)
          ) {
            await this.deps.coordinator.failQueued({
              runId: head.id,
              error: `The queued run cannot start: ${message}`,
            });
            return "failed";
          }
          // Waiting for room is not an error: it never counts toward the
          // bound, so a head that waited long still has every retry.
          await this.db
            .updateTable("workflow_runs")
            .set(
              outcome === "room"
                ? {
                    queue_room_waits: sql<number>`queue_room_waits + 1`,
                    queue_attempted_at: sql<Date>`now()`,
                    queue_blocked: "room",
                    error: message,
                  }
                : {
                    queue_attempts: sql<number>`queue_attempts + 1`,
                    queue_attempted_at: sql<Date>`now()`,
                    queue_blocked: "error",
                    error: message,
                  },
            )
            .where("id", "=", head.id)
            .where("status", "=", "queued")
            .execute();
          if (outcome === "retry")
            console.warn("[catamorphic] A queued run could not start", error);
          return "waiting";
        }
      },
    );
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
      // The live run, never one waiting its turn behind it (ADR 0325).
      .where("status", "not in", ["queued", "completed", "failed", "canceled"])
      .select([
        "id",
        "project_id",
        "workflow_name",
        "session_artifact_id",
        "caller_scope",
      ])
      .executeTakeFirst();
    if (row) await this.assertRunAccess(args.identity, row, false);
    return row ? { id: row.id } : null;
  }

  /**
   * Decides what an enrollment should do about an already-live run for the same
   * key. This observation performs no writes; replacement rechecks and locks
   * the observed generation in its enrollment transaction (ADR 0290).
   */
  private async resolveEnrollmentConflict(args: {
    identity: Identity;
    projectId: string;
    workflowName: string;
    correlationKey: string;
    onConflict: EnrollmentConflictPolicy;
  }): Promise<EnrollmentDecision> {
    if (args.onConflict === "queue") {
      // A run arriving behind queued runs waits too, even in the moment
      // between the last active run settling and the next one starting.
      await this.requireProject(args.identity, args.projectId);
      const ahead = await this.db
        .selectFrom("workflow_runs")
        .select("id")
        .where("project_id", "=", args.projectId)
        .where("workflow_name", "=", args.workflowName)
        .where("correlation_key", "=", args.correlationKey)
        .where("status", "not in", ["completed", "failed", "canceled"])
        .limit(1)
        .executeTakeFirst();
      return ahead ? { kind: "queue" } : { kind: "proceed" };
    }
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
      args.workflowName,
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

  /** Resolve the immutable deployment and static connection contract. */
  async resolveEnablementTarget(args: {
    identity: Identity;
    projectId: string;
    workflowName: string;
    commitSha?: string;
    remoteBranch?: string;
  }): Promise<{
    artifact: DeploymentArtifact;
    requirements: WorkflowGraph["connections"];
    permissions: WorkflowGraph["permissions"];
    documents: WorkflowGraph["documents"];
    secrets: string[];
    remoteBranch?: string;
  }> {
    await this.requireProject(args.identity, args.projectId);
    const source = await this.prepareProductionSource(args);
    if (!source.commitSha) {
      throw new ProductionDeploymentNotFoundError(args.projectId);
    }
    const plugins = await this.loadPlugins(
      args.identity,
      args.projectId,
      args.workflowName,
    );
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
    const retained = await this.db
      .selectFrom("session_artifact_revisions as revision")
      .innerJoin(
        "session_artifacts as source",
        "source.id",
        "revision.artifact_id",
      )
      .where("source.project_id", "=", args.projectId)
      .where("revision.commit_sha", "=", source.commitSha)
      .select("revision.remote_branch")
      .executeTakeFirst();
    return {
      artifact,
      remoteBranch: retained?.remote_branch ?? args.remoteBranch,
      requirements: source.graph.connections,
      permissions: source.graph.permissions,
      documents: source.graph.documents,
      secrets: source.secretNames,
    };
  }

  async resolveArtifactAtCommit(args: {
    identity: Identity;
    projectId: string;
    workflowName: string;
    commitSha: string;
    remoteBranch: string;
  }): Promise<DeploymentArtifact> {
    await this.requireProject(args.identity, args.projectId);
    const source = await this.prepareProductionSource(args);
    if (!source.commitSha)
      throw new ProductionDeploymentNotFoundError(args.projectId);
    const plugins = await this.loadPlugins(
      args.identity,
      args.projectId,
      args.workflowName,
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
    return (
      await this.prepareProductionSource({ ...args, allowInactiveSource: true })
    ).graph.execution;
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
      this.loadPlugins(args.identity, args.projectId, args.workflowName),
      this.deps.deploymentArtifacts.get({ artifactId: args.artifactId }),
    ]);
    if (!artifact) {
      throw new Error(`Deployment artifact '${args.artifactId}' not found`);
    }
    await deploymentRuntime.ensure({
      projectId: args.projectId,
      artifact,
      files: source.files,
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
    permissions: readonly string[];
    documents: WorkflowGraph["documents"];
    displayName?: string;
  }> {
    const graph = (
      await this.prepareProductionSource({ ...args, allowInactiveSource: true })
    ).graph;
    return {
      capabilities: graph.capabilities,
      execution: graph.execution,
      permissions: graph.permissions,
      documents: graph.documents,
      ...(graph.displayName ? { displayName: graph.displayName } : {}),
    };
  }

  async invokeProductionRuntime(args: {
    identity: Identity;
    projectId: string;
    workflowName: string;
    commitSha: string;
    artifactId: string;
    allocationId: string;
    invocationId: string;
    kind: RuntimeInvocation["kind"];
    operation?: string;
    exportName?: string;
    modulePath?: string;
    stepIndex?: number;
    input: unknown;
    attempt: number;
    timeoutSeconds?: number;
    deadlineAt?: string;
    signal?: AbortSignal;
  }): Promise<RuntimeInvocationReceipt> {
    return withSpan(
      {
        tracer,
        name: "workflow.invoke_production_runtime",
        attributes: {
          "catamorphic.workflow.name": args.workflowName,
          "catamorphic.commit.sha": args.commitSha,
          "catamorphic.deployment_artifact.id": args.artifactId,
          "catamorphic.tenant.id": args.identity.tenantId,
          "user.id": args.identity.externalUserId,
          "catamorphic.project.id": args.projectId,
        },
      },
      async () => {
        args.signal?.throwIfAborted();
        const selected = await this.runtimeForAllocation({
          identity: args.identity,
          allocationId: args.allocationId,
        });
        const provider = selected.provider;
        const deploymentRuntime = selected.runtime;
        if (!provider?.deploymentRuntime || !deploymentRuntime) {
          throw new SandboxProviderNotConfiguredError();
        }
        const [source, plugins, artifact] = await Promise.all([
          this.prepareProductionSource({ ...args, allowInactiveSource: true }),
          this.loadPlugins(args.identity, args.projectId, args.workflowName),
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
        args.signal?.throwIfAborted();
        const runtime = await deploymentRuntime.ensure({
          projectId: args.projectId,
          artifact,
          files: source.files,
          plugins: runtimePackagesForArtifact,
        });
        args.signal?.throwIfAborted();
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
          deadlineAt:
            args.deadlineAt ??
            new Date(
              Date.now() + (args.timeoutSeconds ?? 300) * 1_000,
            ).toISOString(),
          env: plugins?.secrets,
          signal: args.signal,
        } as const;
        const targetBase = {
          modulePath: args.modulePath ?? source.workflowFile,
          exportName: args.exportName ?? args.workflowName,
        };
        if (args.kind === "durable-boundary") {
          const receipt = await provider.deploymentRuntime.invoke({
            ...base,
            kind: args.kind,
            target: {
              ...targetBase,
              stepIndex: requireStepIndex(args.stepIndex),
            },
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
      },
    );
  }

  private async runtimeForAllocation(args: {
    identity: Identity;
    allocationId: string;
  }): Promise<{
    provider: SandboxProvider;
    runtime: DeploymentRuntimeService;
  }> {
    const allocation = await this.deps.executionAllocations.get({
      identity: args.identity,
      allocationId: args.allocationId,
    });
    if (allocation?.status !== "active") {
      throw new Error("Workflow Allocation is unavailable");
    }
    const binding = await this.deps.executionEnvironments.getRuntimeBinding({
      identity: args.identity,
      bindingId: allocation.bindingId,
      ...(allocation.workerNodeId
        ? { workerNodeId: allocation.workerNodeId }
        : {}),
    });
    const baseProvider = binding?.sandboxProvider;
    const provider =
      baseProvider && allocation.workerNodeId
        ? allocationSandboxProvider({
            db: this.db,
            allocation,
            provider: baseProvider,
            workerLeaseToken: binding?.workerLeaseToken,
          })
        : baseProvider;
    if (!provider?.deploymentRuntime) {
      throw new SandboxProviderNotConfiguredError();
    }
    // Runtimes on a static binding are shared by every run of the same
    // artifact there: an allocation is one run's capacity lease, and keying
    // runtimes by it booted a fresh sandbox per call (tens of seconds each
    // time an app asked a workflow). Worker-node allocations keep their own
    // runtimes; their sandboxes live under the allocation's lease.
    const runtimeScope = allocation.workerNodeId
      ? allocation.id
      : allocation.bindingId;
    const runtime = new EnvironmentDeploymentRuntimeService(
      new KyselyDeploymentRuntimeStore(this.db, runtimeScope),
      {
        provider,
        resources: {
          cpuMillis: allocation.policy.requirements.resources?.cpuMillis,
          memoryMb: allocation.policy.requirements.resources?.memoryMb,
          storageMb: allocation.policy.requirements.resources?.storageMb,
          gpu: allocation.policy.requirements.resources?.gpu,
        },
        artifacts: this.deps.deploymentArtifacts,
        maxConcurrency: this.deps.deploymentRuntimeOptions?.maxConcurrency,
        autoStopMinutes: this.deps.deploymentRuntimeOptions?.autoStopMinutes,
      },
    );
    // Runtime state and locks live in the store/provider. The allocation
    // wrapper is cheap and must not retain every historical allocation.
    return { provider, runtime };
  }

  private async trigger(
    args: {
      identity: Identity;
      projectId: string;
      workflowName: string;
      environment?: string;
      input?: Json;
      correlationKey?: string;
      onConflict?: EnrollmentConflictPolicy;
      unattended?: boolean;
      connectionAuthorizationSnapshot?: readonly ResolvedConnectionBinding[];
      workflowEnablementId?: string;
      enablementSnapshot?: Pick<
        WorkflowEnablement,
        "commitSha" | "consentDigest" | "revision"
      >;
      commitSha?: string;
      remoteBranch?: string;
      /** Runs at `commitSha`, ahead of its enablement (ADR 0331). */
      atRevision?: true;
    },
    internal: RunInternalFacts = {},
  ): Promise<Run> {
    return withSpan(
      {
        tracer,
        name: "workflow.run",
        attributes: {
          // This call creates/resolves its own run; do not label it with a caller's run/job.
          "catamorphic.run.id": undefined,
          "catamorphic.project.id": args.projectId,
          "catamorphic.workflow.name": args.workflowName,
          "catamorphic.tenant.id": args.identity.tenantId,
          "user.id": args.identity.externalUserId,
        },
      },
      async (span) => {
        assertTokenScope(args.identity, "sessions:run");
        if (args.identity.scope) {
          // Viewers reach exactly what their scope resolves to.
          await assertScopeAllowsWorkflow({
            db: this.db,
            identity: args.identity,
            projectId: args.projectId,
            workflowName: args.workflowName,
            policies: this.deps.appPolicies,
          });
        }
        const scope = await resolveScope({
          db: this.db,
          identity: args.identity,
          projectId: args.projectId,
          policies: this.deps.appPolicies,
        });
        const source = scope?.sessionApp;
        if (
          source &&
          (!source.active ||
            (args.commitSha && args.commitSha !== source.commitSha) ||
            (args.remoteBranch && args.remoteBranch !== source.remoteBranch))
        )
          throw new AccessDeniedError();
        const run = await this.triggerInner(
          source
            ? {
                ...args,
                commitSha: source.commitSha,
                remoteBranch: source.remoteBranch,
              }
            : args,
          internal,
        );
        setSpanCorrelation({
          span,
          attributes: { "catamorphic.run.id": run.id },
        });
        span.setAttribute("catamorphic.run.status", run.status);
        return run;
      },
    );
  }

  private async triggerInner(
    args: {
      identity: Identity;
      projectId: string;
      workflowName: string;
      environment?: string;
      input?: Json;
      correlationKey?: string;
      onConflict?: EnrollmentConflictPolicy;
      deliveryKey?: string;
      unattended?: boolean;
      connectionAuthorizationSnapshot?: readonly ResolvedConnectionBinding[];
      workflowEnablementId?: string;
      enablementSnapshot?: Pick<
        WorkflowEnablement,
        "commitSha" | "consentDigest" | "revision"
      >;
      commitSha?: string;
      remoteBranch?: string;
      /** Runs at `commitSha`, ahead of its enablement (ADR 0331). */
      atRevision?: true;
      /** Start this queued run instead of enrolling a new one (ADR 0325). */
      start?: { runId: string };
    },
    internal: RunInternalFacts = {},
  ): Promise<Run> {
    await this.requireProject(args.identity, args.projectId);
    const deliveryKey =
      args.deliveryKey && !args.start
        ? requireDeliveryKey(args.deliveryKey)
        : undefined;
    if (deliveryKey) {
      const delivered = await this.findByDeliveryKey({
        projectId: args.projectId,
        workflowName: args.workflowName,
        deliveryKey,
      });
      if (delivered)
        return this.get({ identity: args.identity, runId: delivered });
    }
    const source = await this.prepareProductionSource(args);
    // Only the host's dispatch of a host-only kind starts a workflow bound
    // to one; a queued run was checked when it enrolled (ADR 0327).
    if (!args.start) {
      const hostOnly = source.graph.triggers
        .map((trigger) => trigger.kind)
        .filter((kind) => this.deps.hostOnlyKind?.(kind) === true);
      if (
        hostOnly.length > 0 &&
        !(internal.dispatchedKind && hostOnly.includes(internal.dispatchedKind))
      )
        throw new WorkflowHostOnlyError(args.workflowName, hostOnly);
    }
    const input = args.input ?? null;
    // An explicit key is the host's; otherwise the workflow's declaration
    // names the subject from the input (ADR 0325).
    const declared = args.correlationKey ? undefined : source.graph.concurrency;
    const derivedKey = declared
      ? correlationKeyAtPath(input, declared.key)
      : undefined;
    const correlationKey = args.correlationKey
      ? requireCorrelationKey(args.correlationKey)
      : derivedKey;
    const onConflict: EnrollmentConflictPolicy = derivedKey
      ? (declared?.onConflict ?? "ignore")
      : (args.onConflict ?? "ignore");
    // Queued runs alike by the workflow's own paths join (ADR 0337), and
    // only an event delivery no caller waits for joins one.
    const coalesceValues =
      derivedKey &&
      onConflict === "queue" &&
      declared?.coalesce &&
      internal.delivery
        ? coalesceValuesAtPaths(input, declared.coalesce)
        : null;
    let coalesceKey: string | null = null;
    let supersededRunId: string | null = null;
    let queue = false;
    if (correlationKey && !args.start) {
      const decision = await this.resolveEnrollmentConflict({
        identity: args.identity,
        projectId: args.projectId,
        workflowName: args.workflowName,
        correlationKey,
        onConflict,
      });
      if (decision.kind === "existing") return decision.run;
      if (decision.kind === "restart") supersededRunId = decision.runId;
      if (decision.kind === "queue") queue = true;
    }
    const plugins = await this.loadPlugins(
      args.identity,
      args.projectId,
      args.workflowName,
    );
    // The graph's input schema is a projection of the workflow's TS input
    // type; rejecting here fails at the door with a path-level error instead
    // of deep inside a sandbox invocation.
    const inputErrors = validateAgainstSchema(input, source.graph.inputSchema);
    if (inputErrors.length > 0) {
      throw new RunInputInvalidError(args.workflowName, inputErrors);
    }
    const runId = args.start?.runId ?? crypto.randomUUID();
    // A run that waits its turn holds nothing: it is admitted when it starts.
    const admission = queue
      ? undefined
      : await this.deps.executionEnvironments.admit({
          identity: args.identity,
          projectId: args.projectId,
          environment: args.environment,
          requirements: { workload: "workflow" },
        });
    const connectionRequirements = source.graph.connections ?? [];
    if (
      admission &&
      (args.connectionAuthorizationSnapshot?.length ||
        connectionRequirements.length > 0) &&
      !this.deps.connectionAdmission
    ) {
      throw new Error("Connection providers are not configured");
    }
    const connections = !admission
      ? []
      : args.connectionAuthorizationSnapshot?.length
        ? await this.deps.connectionAdmission!.admitSnapshot({
            identity: args.identity,
            projectId: args.projectId,
            environment: admission.environmentName,
            snapshot: args.connectionAuthorizationSnapshot,
          })
        : connectionRequirements.length > 0
          ? await this.deps.connectionAdmission!.admit({
              identity: args.identity,
              projectId: args.projectId,
              environment: admission.environmentName,
              requirements: connectionRequirements,
              unattended: args.unattended,
            })
          : [];
    if (!source.commitSha)
      throw new ProductionDeploymentNotFoundError(args.projectId);
    const provenance: RunProvenance = {
      commitSha: source.commitSha,
      ...(source.graph.displayName
        ? { displayName: source.graph.displayName }
        : {}),
    };
    const enrollment: QueuedEnrollment = {
      ...(args.environment ? { environment: args.environment } : {}),
      ...(args.unattended ? { unattended: true } : {}),
      ...(args.workflowEnablementId
        ? { enablementId: args.workflowEnablementId }
        : {}),
      ...(args.workflowEnablementId && args.atRevision
        ? { atRevision: true as const }
        : {}),
      commitSha: source.commitSha,
      ...(args.remoteBranch ? { remoteBranch: args.remoteBranch } : {}),
      ...(ownerNarrowing(args.identity)
        ? { owner: ownerNarrowing(args.identity) }
        : {}),
    };
    {
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
      // Resolve the old runtime while its allocation is still active, but
      // do not touch execution until cancellation and replacement commit.
      if (supersededRunId)
        await this.assertRunPermission(
          args.identity,
          supersededRunId,
          "runs:write",
        );
      const previous = supersededRunId
        ? await this.get({ identity: args.identity, runId: supersededRunId })
        : undefined;
      const previousRuntime = previous?.allocationId
        ? await this.runtimeForAllocation({
            identity: args.identity,
            allocationId: previous.allocationId,
          }).catch(() => undefined)
        : undefined;
      let queued = false;
      let joined: string | null = null;
      try {
        const invocations = await this.db.transaction().execute(async (trx) => {
          // Enrollment and retirement serialize on the retained source row.
          // Source preparation may race discard; it must not enqueue work after it.
          const retained = await trx
            .selectFrom("session_artifacts")
            .selectAll()
            .where("project_id", "=", args.projectId)
            .where(
              "id",
              "in",
              trx
                .selectFrom("session_artifact_revisions")
                .select("artifact_id")
                .where("commit_sha", "=", source.commitSha),
            )
            .forUpdate()
            .executeTakeFirst();
          if (retained) {
            const session = retained.session_id
              ? await trx
                  .selectFrom("agent_sessions")
                  .select("status")
                  .where("id", "=", retained.session_id)
                  .executeTakeFirst()
              : undefined;
            if (
              retained.status !== "active" ||
              (retained.lifetime === "session" &&
                session?.status !== "active") ||
              retained.owner_external_user_id !== args.identity.externalUserId
            )
              throw new AccessDeniedError();
          } else if (
            [
              `${MANAGED_BRANCH_PREFIX}artifacts/`,
              `${MANAGED_BRANCH_PREFIX}watchers/`,
            ].some((prefix) => (args.remoteBranch ?? "").startsWith(prefix))
          )
            throw new AccessDeniedError();
          if (args.workflowEnablementId && args.enablementSnapshot) {
            // The caller authorized this exact consented snapshot. An update
            // during source/admission preparation cannot replace its authority.
            const live = await trx
              .selectFrom("workflow_enablements")
              .select([
                "commit_sha",
                "consent_digest",
                "revision",
                "status",
                "expires_at",
              ])
              .where("id", "=", args.workflowEnablementId)
              .where("tenant_id", "=", args.identity.tenantId)
              .where("project_id", "=", args.projectId)
              .forUpdate()
              .executeTakeFirst();
            if (
              live?.status !== "active" ||
              (live.expires_at && live.expires_at <= new Date())
            )
              throw new AccessDeniedError();
            if (
              live.commit_sha !== args.enablementSnapshot.commitSha ||
              live.consent_digest !== args.enablementSnapshot.consentDigest ||
              live.revision !== args.enablementSnapshot.revision
            )
              throw new EnablementMovedError();
          }
          if (correlationKey && onConflict === "queue") {
            // Enrollment and start decide under one lock per key, so a run
            // either starts or is queued behind one that will start it.
            await lockCorrelationKey({
              trx,
              projectId: args.projectId,
              workflowName: args.workflowName,
              correlationKey,
            });
            // A delivery that joined a run while this one waited for the
            // lock is that run's (ADR 0337).
            const rejoined = deliveryKey
              ? await trx
                  .selectFrom("workflow_run_joins")
                  .select("run_id")
                  .where("project_id", "=", args.projectId)
                  .where("workflow_name", "=", args.workflowName)
                  .where("delivery_key", "=", deliveryKey)
                  .executeTakeFirst()
              : undefined;
            if (rejoined) {
              joined = rejoined.run_id;
              return [];
            }
            const keyed = trx
              .selectFrom("workflow_runs")
              .where("project_id", "=", args.projectId)
              .where("workflow_name", "=", args.workflowName)
              .where("correlation_key", "=", correlationKey);
            if (args.start) {
              const own = await keyed
                .select(["id", "status", "queued_at"])
                .where("id", "=", runId)
                .forUpdate()
                .executeTakeFirst();
              const blocking = await keyed
                .select("id")
                .where("id", "!=", runId)
                .where((eb) =>
                  eb.or([
                    eb("status", "not in", [
                      "queued",
                      "completed",
                      "failed",
                      "canceled",
                    ]),
                    eb.and([
                      eb("status", "=", "queued"),
                      sql<boolean>`(queued_at, id) < (${own?.queued_at ?? null}, ${runId}::uuid)`,
                    ]),
                  ]),
                )
                .limit(1)
                .executeTakeFirst();
              if (own?.status !== "queued" || blocking)
                throw new QueuedRunNotReadyError(runId);
            } else {
              const ahead = await keyed
                .select((eb) => [
                  eb.fn.countAll().as("all"),
                  eb.fn
                    .count("id")
                    .filterWhere("status", "=", "queued")
                    .as("queued"),
                ])
                .where("status", "not in", ["completed", "failed", "canceled"])
                .executeTakeFirstOrThrow();
              queued = queue || Number(ahead.all) > 0;
              coalesceKey =
                coalesceValues === null
                  ? null
                  : coalesceKeyOf({
                      values: coalesceValues,
                      artifact: artifact.id,
                      sessionArtifact: retained?.id ?? null,
                      environment: args.environment ?? null,
                      owner: args.identity.externalUserId,
                      scope: toJson(args.identity.scope ?? null),
                      executionScope: toJson(
                        args.identity.executionScope ?? null,
                      ),
                      connectionScope: toJson(
                        args.identity.connectionScope ?? null,
                      ),
                      enablement: args.workflowEnablementId ?? null,
                    });
              // A run alike one still queued joins it: that run reads the
              // state when it starts, so it answers this one's event too
              // (ADR 0337). Its delivery is recorded against that run, so
              // a redelivery returns it.
              const alike =
                queued && coalesceKey !== null
                  ? await keyed
                      .select("id")
                      .where("status", "=", "queued")
                      .where("coalesce_key", "=", coalesceKey)
                      .orderBy("queued_at")
                      .limit(1)
                      .executeTakeFirst()
                  : undefined;
              if (alike) {
                joined = alike.id;
                if (deliveryKey)
                  await trx
                    .insertInto("workflow_run_joins")
                    .values({
                      project_id: args.projectId,
                      workflow_name: args.workflowName,
                      delivery_key: deliveryKey,
                      run_id: alike.id,
                    })
                    .onConflict((conflict) => conflict.doNothing())
                    .execute();
                return [];
              }
              if (queued && Number(ahead.queued) >= MAX_QUEUED_RUNS_PER_KEY)
                throw new RunQueueFullError(args.workflowName, correlationKey);
            }
          }
          const row = {
            project_id: args.projectId,
            workflow_name: args.workflowName,
            correlation_key: correlationKey ?? null,
            provenance: toJson({
              ...provenance,
              capabilities: source.graph.capabilities,
            }),
            deployment_artifact_id: artifact.id,
            session_artifact_id: retained?.id ?? null,
            workflow_enablement_id: args.workflowEnablementId ?? null,
            phase:
              source.graph.execution.steps[0]?.type === "batch"
                ? "source"
                : "boundary",
          };
          const caller = {
            external_user_id: args.identity.externalUserId,
            // Who triggered the run, as verified by the host (ADR 0055):
            // the caller's scope, or null for the root identity. A scoped
            // caller's run reaches only the store paths its workflow
            // declares, of what the caller reaches (ADR 0335), whoever
            // started it.
            caller_scope:
              args.identity.scope === undefined
                ? null
                : jsonColumn(
                    toJson(
                      narrowStoreDocuments({
                        scope: args.identity.scope,
                        projectId: args.projectId,
                        documents: source.graph.documents,
                      }),
                    ),
                  ),
            caller_execution_scope:
              args.identity.executionScope === undefined
                ? null
                : jsonColumn(toJson(args.identity.executionScope)),
            caller_connection_scope:
              args.identity.connectionScope === undefined
                ? null
                : jsonColumn(toJson(args.identity.connectionScope)),
            // A scoped caller's run acts with only what it holds of the
            // workflow's declared permissions (ADR 0158).
            caller_project_permissions:
              args.identity.scope === undefined
                ? null
                : jsonColumn(
                    toJson(
                      intersectProjectPermissions(
                        source.graph.permissions.map((permission) => ({
                          projectId: args.projectId,
                          permission,
                        })),
                        args.identity,
                      ),
                    ),
                  ),
          };
          // Only the event dispatcher states this, at enrollment; starting
          // a queued run never rewrites it (ADR 0355).
          const delivered = { event_id: internal.eventId ?? null };
          if (queued) {
            await trx
              .insertInto("workflow_runs")
              .values({
                id: runId,
                ...row,
                ...caller,
                ...delivered,
                environment_name: args.environment ?? null,
                delivery_key: deliveryKey ?? null,
                coalesce_key: coalesceKey,
                status: "queued",
                queued_at: sql<Date>`clock_timestamp()`,
                enrollment: jsonColumn(toJson(enrollment)),
                input: jsonColumn(input),
              })
              .execute();
            return [];
          }
          if (!admission) throw new QueuedRunNotReadyError(runId);
          // Lock the live generation again after preparation. A competing
          // restart must not lend us authority over its replacement.
          const replacing =
            supersededRunId && correlationKey
              ? await trx
                  .selectFrom("workflow_runs")
                  .select("id")
                  .where("project_id", "=", args.projectId)
                  .where("workflow_name", "=", args.workflowName)
                  .where("correlation_key", "=", correlationKey)
                  .where("status", "not in", [
                    "queued",
                    "completed",
                    "failed",
                    "canceled",
                  ])
                  .forUpdate()
                  .executeTakeFirst()
              : undefined;
          if (replacing && replacing.id !== supersededRunId)
            throw new RunEnrollmentConflictError(
              args.workflowName,
              correlationKey ?? "",
              replacing.id,
            );
          const canceled = replacing
            ? await this.deps.coordinator.cancel({
                identity: args.identity,
                runId: replacing.id,
                reason: `Re-enrolled for correlation key '${correlationKey}'`,
                trx,
              })
            : [];
          // Replacing a live run cannot grow the logical active set, even
          // when an operator lowered the limit below existing load.
          if (!replacing) {
            await this.deps.tenantPolicies.assertActiveRunCapacity({
              trx,
              tenantId: args.identity.tenantId,
            });
          }
          const allocation = await this.deps.executionAllocations.create({
            identity: args.identity,
            projectId: args.projectId,
            environmentName: admission.environmentName,
            workloadKind: "workflow",
            rootWorkloadId: runId,
            workerNodeId: admission.runtime.workerNodeId,
            policy: admissionPolicy({
              admission,
              connections,
              ...(args.workflowEnablementId
                ? { workflowEnablementId: args.workflowEnablementId }
                : {}),
            }),
            transaction: trx,
          });
          if (args.start) {
            // The run keeps who enrolled it; it now runs where it was
            // admitted, holding what that owner holds now of the starting
            // commit's declarations (ADRs 0158, 0335), not what it held
            // when it queued.
            const { external_user_id: _enrolled, ...holds } = caller;
            await trx
              .updateTable("workflow_runs")
              .set({
                ...row,
                ...holds,
                allocation_id: allocation.id,
                environment_name: admission.environmentName,
                status: "pending",
                updated_at: sql<Date>`now()`,
              })
              .where("id", "=", runId)
              .where("status", "=", "queued")
              .execute();
          } else {
            await trx
              .insertInto("workflow_runs")
              .values({
                id: runId,
                ...row,
                ...caller,
                ...delivered,
                allocation_id: allocation.id,
                environment_name: admission.environmentName,
                delivery_key: deliveryKey ?? null,
                status: "pending",
                input: jsonColumn(input),
              })
              .execute();
          }
          await this.deps.coordinator.initialize({
            trx,
            tenantId: args.identity.tenantId,
            runId,
            execution: source.graph.execution,
            input,
          });
          return canceled;
        });
        const runtime = previousRuntime?.runtime ?? this.deps.deploymentRuntime;
        await Promise.all(
          invocations.map((invocation) =>
            runtime?.cancel(invocation).catch(() => {}),
          ),
        );
      } catch (error) {
        if (deliveryKey && isDeliveryKeyConflict(error)) {
          const delivered = await this.findByDeliveryKey({
            projectId: args.projectId,
            workflowName: args.workflowName,
            deliveryKey,
          });
          if (delivered)
            return this.get({ identity: args.identity, runId: delivered });
        }
        if (correlationKey && !args.start && isCorrelationKeyConflict(error)) {
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
      // The run ahead may have settled while this one was enrolling.
      if (queued && correlationKey)
        await this.startQueuedRuns({
          projectId: args.projectId,
          workflowName: args.workflowName,
          correlationKey,
        }).catch(() => {});
      return this.get({ identity: args.identity, runId: joined ?? runId });
    }
  }

  private async findByDeliveryKey(args: {
    projectId: string;
    workflowName: string;
    deliveryKey: string;
  }): Promise<string | undefined> {
    const row = await this.db
      .selectFrom("workflow_runs")
      .select("id")
      .where("project_id", "=", args.projectId)
      .where("workflow_name", "=", args.workflowName)
      .where("delivery_key", "=", args.deliveryKey)
      .executeTakeFirst();
    if (row) return row.id;
    // A delivery that joined a queued run alike it (ADR 0337).
    const joined = await this.db
      .selectFrom("workflow_run_joins")
      .select("run_id")
      .where("project_id", "=", args.projectId)
      .where("workflow_name", "=", args.workflowName)
      .where("delivery_key", "=", args.deliveryKey)
      .executeTakeFirst();
    return joined?.run_id;
  }

  private async assertRetainedSourceAccess(args: {
    identity: Identity;
    projectId: string;
    commitSha?: string;
    allowInactiveSource?: boolean;
  }) {
    const retained = args.commitSha
      ? await this.db
          .selectFrom("session_artifacts as source")
          .innerJoin(
            "session_artifact_revisions as revision",
            "revision.artifact_id",
            "source.id",
          )
          .where("source.project_id", "=", args.projectId)
          .where("revision.commit_sha", "=", args.commitSha)
          .select([
            "source.owner_external_user_id",
            "source.lifetime",
            "source.session_id",
            "source.name",
            "source.status",
          ])
          .executeTakeFirst()
      : undefined;
    if (retained && retained.status !== "active" && !args.allowInactiveSource)
      throw new AccessDeniedError();
    if (
      retained &&
      retained.owner_external_user_id !== args.identity.externalUserId
    )
      throw new AccessDeniedError();
    if (
      retained?.lifetime === "member" &&
      !identityCovers(args.identity, {
        kind: "workflow",
        projectId: args.projectId,
        name: retained.name,
      })
    )
      throw new AccessDeniedError();
    return retained;
  }

  private async prepareProductionSource(args: {
    identity: Identity;
    projectId: string;
    workflowName: string;
    commitSha?: string;
    remoteBranch?: string;
    allowInactiveSource?: boolean;
  }): Promise<PreparedSource> {
    const retained = await this.assertRetainedSourceAccess(args);
    if (retained?.lifetime === "member" && args.commitSha) {
      const key = preparedSourceKey({ ...args, commitSha: args.commitSha });
      const hit = this.recallPreparedSource(key);
      if (hit) return hit;
      const files = await this.deps.privateSource?.({
        ...args,
        commitSha: args.commitSha,
      });
      if (!files) throw new AccessDeniedError();
      return this.rememberPreparedSource(
        key,
        prepareSource({
          projectId: args.projectId,
          workflowName: args.workflowName,
          files,
          commitSha: args.commitSha,
        }),
      );
    }
    const remote = this.deps.projectManager.remoteBackend;
    if (!remote) throw new ProductionDeploymentNotFoundError(args.projectId);

    // A pinned sha names immutable content, so the parse behind it can be
    // reused without touching the repository at all.
    if (args.commitSha) {
      const hit = this.recallPreparedSource(
        preparedSourceKey({ ...args, commitSha: args.commitSha }),
      );
      if (hit) return hit;
    }
    const repo = await this.deps.projectManager.openDraft({
      tenantId: args.identity.tenantId,
      projectId: args.projectId,
      externalUserId: args.identity.externalUserId,
    });
    try {
      // A preview app build (the `dev` channel) is compiled from the caller's
      // draft, so its calls read the same files; HEAD is recorded as
      // provenance only.
      if (!args.commitSha && callsPreviewApp(args.identity)) {
        return await prepareSource({
          projectId: args.projectId,
          workflowName: args.workflowName,
          files: await repo.readAllFiles({ filter: isWorkflowSourceFile }),
          commitSha: await repo.resolveRef("HEAD").catch(() => null),
        });
      }
      await refreshPublished({
        repo,
        remote,
        tenantId: args.identity.tenantId,
        projectId: args.projectId,
        branch: args.remoteBranch ?? "main",
      });
      // Without a sha the caller asks for "whatever main is now": the ref is
      // resolved first so that an unchanged main is still a cache hit.
      const commitSha =
        args.commitSha ??
        (await repo.resolveRef(PUBLISHED_REF).catch(() => null));
      if (!commitSha)
        throw new ProductionDeploymentNotFoundError(args.projectId);
      const key = preparedSourceKey({ ...args, commitSha });
      return await (this.recallPreparedSource(key) ??
        this.rememberPreparedSource(
          key,
          repo
            .readAllFilesAtRef(commitSha, { filter: isWorkflowSourceFile })
            .then((files) =>
              prepareSource({
                projectId: args.projectId,
                workflowName: args.workflowName,
                files,
                commitSha,
              }),
            ),
        ));
    } finally {
      await repo.dispose();
    }
  }

  /**
   * Memoises a parsed commit by (tenant, project, workflow, sha).
   *
   * Every durable boundary and every batch item invokes the runtime, and each
   * invocation needs the transformed source. Recomputing it per invocation
   * means a full git fetch plus a whole-project ts-morph parse per step, so a
   * 10k-item batch parses the project 10k times. A sha is immutable, so a hit
   * is always valid.
   *
   * The promise is cached before it settles, so concurrent items on the same
   * commit collapse into one parse instead of stampeding.
   */
  private rememberPreparedSource(
    key: string,
    load: Promise<PreparedSource>,
  ): Promise<PreparedSource> {
    // Each deploy strands its predecessor's entry, so the map is capped and
    // evicted least-recently-used (recallPreparedSource refreshes recency, and
    // Map preserves insertion order). Evicting by insertion alone would purge
    // the busiest entry on schedule under multi-tenant load: with more than
    // PREPARED_SOURCE_CACHE_MAX live (tenant, project, workflow, sha) keys,
    // the hottest batch re-pays a git fetch and full parse every cycle.
    if (this.preparedSources.size >= PREPARED_SOURCE_CACHE_MAX) {
      const oldest = this.preparedSources.keys().next();
      if (!oldest.done) {
        this.preparedSources.delete(oldest.value);
        this.preparedSourceBytes.delete(oldest.value);
      }
    }
    this.preparedSources.set(key, load);
    // A failed parse must not be remembered, or the run retries against a
    // cached rejection forever.
    void load.then(
      (source) => {
        if (this.preparedSources.get(key) !== load) return;
        const size = Buffer.byteLength(JSON.stringify(source));
        this.preparedSourceBytes.set(key, size);
        let total = [...this.preparedSourceBytes.values()].reduce(
          (sum, bytes) => sum + bytes,
          0,
        );
        for (const cachedKey of this.preparedSources.keys()) {
          if (total <= 64 * 1024 * 1024) break;
          total -= this.preparedSourceBytes.get(cachedKey) ?? 0;
          this.preparedSourceBytes.delete(cachedKey);
          this.preparedSources.delete(cachedKey);
        }
      },
      () => {
        if (this.preparedSources.get(key) === load) {
          this.preparedSources.delete(key);
          this.preparedSourceBytes.delete(key);
        }
      },
    );
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
    workflowName?: string,
  ) {
    if (!this.deps.runPluginsLoader) return undefined;
    const plugins = await this.deps.runPluginsLoader.load({
      identity,
      projectId,
      workflowName,
    });
    if (plugins.missingRequiredSecrets.length > 0) {
      throw new PluginSecretsMissingError(plugins.missingRequiredSecrets);
    }
    return plugins;
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

  /**
   * Drill-downs (`runs:read`) and controls (`runs:write`) on one run: your
   * own runs need no permission, anyone's else do (ADR 0158). A run names
   * its project, so the check goes through the run row, tenant-filtered: a
   * foreign run id reads as denied, never as a pass.
   */
  private async assertRunAccess(
    identity: Identity,
    row: Pick<
      RunRow,
      "project_id" | "workflow_name" | "session_artifact_id" | "caller_scope"
    >,
    checkWorkflowScope = true,
  ): Promise<void> {
    if (row.session_artifact_id) {
      const source = await this.db
        .selectFrom("session_artifacts")
        .leftJoin(
          "agent_sessions",
          "agent_sessions.id",
          "session_artifacts.session_id",
        )
        .where("session_artifacts.id", "=", row.session_artifact_id)
        .where("session_artifacts.project_id", "=", row.project_id)
        .where(
          "session_artifacts.owner_external_user_id",
          "=",
          identity.externalUserId,
        )
        .select([
          "session_artifacts.id",
          "session_artifacts.lifetime",
          "agent_sessions.agent_id",
        ])
        .executeTakeFirst();
      if (!source) throw new AccessDeniedError();
      if (
        source.lifetime === "session" &&
        !identityCovers(identity, {
          kind: "app",
          projectId: row.project_id,
          name: `session-${source.id}`,
        })
      ) {
        assertAgentSessionAccess({
          identity,
          projectId: row.project_id,
          externalUserId: identity.externalUserId,
          agentId: source.agent_id,
          intent: "change",
        });
      }
    }
    if (
      identity.scope &&
      (checkWorkflowScope || row.session_artifact_id !== null)
    ) {
      // Run polling mirrors triggering (ADR 0036, 0053): a scoped identity
      // may read only runs of workflows its scope resolves to, within the
      // run's own project — never arbitrary tenant runs by id.
      const context = await resolveScope({
        db: this.db,
        identity,
        projectId: row.project_id,
        policies: this.deps.appPolicies,
      });
      if (context?.sessionApp) {
        const callerScope = Array.isArray(row.caller_scope)
          ? row.caller_scope
          : [];
        if (
          !callerScope.some(
            (ref) =>
              ref &&
              typeof ref === "object" &&
              !Array.isArray(ref) &&
              ref.kind === "app" &&
              ref.name === context.sessionApp?.name,
          )
        )
          throw new AccessDeniedError();
      }
      if (context && !context.allowedWorkflows.has(row.workflow_name)) {
        throw new AccessDeniedError();
      }
    }
  }

  private async assertRunPermission(
    identity: Identity,
    runId: string,
    permission: "runs:read" | "runs:write",
  ): Promise<void> {
    assertTokenScope(
      identity,
      permission === "runs:write" ? "sessions:run" : "work:read",
    );
    const row = await this.db
      .selectFrom("workflow_runs")
      .innerJoin("projects", "projects.id", "workflow_runs.project_id")
      .where("workflow_runs.id", "=", runId)
      .where("projects.tenant_id", "=", identity.tenantId)
      .select([
        "workflow_runs.project_id",
        "workflow_runs.external_user_id",
        "workflow_runs.workflow_name",
        "workflow_runs.session_artifact_id",
        "workflow_runs.caller_scope",
      ])
      .executeTakeFirst();
    // Uniform denial: a scoped caller must not learn which run ids exist.
    if (!row) throw new AccessDeniedError();
    await this.assertRunAccess(identity, row, false);
    if (
      identity.scope === undefined ||
      row.external_user_id === identity.externalUserId
    )
      return;
    assertProjectPermission(identity, row.project_id, permission);
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

/** The source every viewer of a published app runs. */
const PUBLISHED_REF = publishedRef();

/** Files a run's workflows are parsed from; app data is host state, not source. */
const isWorkflowSourceFile = isProjectSourcePath;

/** Whether a run is an app on its `dev` channel calling in (ADR 0148). */
function callsPreviewApp(identity: Identity): boolean {
  return (
    identity.scope?.some(
      (ref) => ref.kind === "app" && ref.channel === "dev",
    ) ?? false
  );
}

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
  ].join("\0");
}

async function prepareSource(args: {
  projectId: string;
  workflowName: string;
  files: Record<string, string>;
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
    workflowFile: prepared.graph.filePath,
    graph: prepared.graph,
    secretNames: prepared.secrets
      .filter((secret) => secret.use === "run")
      .map((secret) => secret.name)
      .sort(),
    commitSha: args.commitSha,
    workflowPackage: await resolveWorkflowPackageFallback({
      packageJson: workflowPackageJson(files),
      hasLockfile: hasProjectLockfile(files),
    }),
  };
}

/**
 * The workflow package declaration lives in the contained workflows member.
 */
function workflowPackageJson(
  files: Record<string, string>,
): string | undefined {
  return files[PROJECT_WORKFLOWS_PACKAGE_PATH];
}

function mapRun(args: {
  row: RunRow & {
    current_step_index: number | null;
    active_workflow_step_attempt_id: string | null;
  };
  pause: Selectable<DB["workflow_pauses"]> | undefined;
  connectionActionRequired:
    | Selectable<DB["connection_action_requirements"]>
    | undefined;
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
  // A host-call wait (ADR 0324) takes no input: its call's result ends it.
  const openPause = args.pause?.status === "open" && !args.pause.host_call;
  return {
    id: args.row.id,
    projectId: args.row.project_id,
    workflowName: args.row.workflow_name,
    correlationKey: args.row.correlation_key,
    environment: args.row.environment_name,
    allocationId: args.row.allocation_id,
    workflowEnablementId: args.row.workflow_enablement_id,
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
    connectionActionRequired: args.connectionActionRequired
      ? {
          id: args.connectionActionRequired.id,
          environment: args.connectionActionRequired.environment_name,
          alias: args.connectionActionRequired.alias,
          status: "pending",
          createdAt: args.connectionActionRequired.created_at.toISOString(),
        }
      : null,
    batchScopes: args.batchScopes,
    provenance: {
      ...(typeof provenance.commitSha === "string"
        ? { commitSha: provenance.commitSha }
        : {}),
      ...(typeof provenance.displayName === "string"
        ? { displayName: provenance.displayName }
        : {}),
    },
    ...(args.row.deployment_artifact_id
      ? { artifact: { deploymentArtifactId: args.row.deployment_artifact_id } }
      : {}),
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
    value === "queued" ||
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
