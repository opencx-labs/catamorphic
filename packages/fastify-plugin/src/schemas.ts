import {
  type AgentTurnUsage,
  type Attempt,
  attachmentSchema,
  type CommandReceipt,
  type DispatchMode,
  dispatchModeSchema,
  type Item,
  type JsonObject,
  jsonValueSchema,
  type NativeRef,
  type ProviderThread,
  type RuntimeRequest,
  type RuntimeRequestResponse,
  type SessionCommand,
  type SessionEvent,
  type SessionFields,
  type SessionMessageAuthor,
  type SessionSnapshot,
  type SessionStreamMessage,
  type StoredSessionEvent,
  sessionCommandSchema,
  sessionMessageAuthorSchema,
  type Turn,
  type TurnError,
  type TurnOutcome,
} from "@catamorphic/agent-protocol";
import { RUNNER_PROTOCOL_VERSION } from "@catamorphic/agent-protocol/runner";
import { APP_ICON_NAMES } from "@catamorphic/app";
import {
  RoleDefinitionSchema as CoreRoleDefinitionSchema,
  PROJECT_PERMISSION_PATTERN,
} from "@catamorphic/core";
import {
  CLAUDE_CODE_PERMISSION_MODES,
  CODEX_APPROVAL_POLICIES,
  CODEX_SANDBOX_MODES,
  SANDBOXING_LEVELS,
} from "@catamorphic/sandbox";
import { z } from "zod";

// --- Params ---
export const ProjectIdParamsSchema = z.object({
  projectId: z.string().uuid(),
});

export const WorkflowNameParamsSchema = ProjectIdParamsSchema.extend({
  name: z.string().min(1),
});

export const ProjectFileParamsSchema = ProjectIdParamsSchema.extend({
  "*": z.string().min(1),
});

export const RunIdParamsSchema = z.object({
  runId: z.string().uuid(),
});

export const RunPauseParamsSchema = RunIdParamsSchema.extend({
  pauseId: z.string().uuid(),
});

export const RunStepAttemptParamsSchema = RunIdParamsSchema.extend({
  workflowStepAttemptId: z.string().uuid(),
});

export const RunItemParamsSchema = RunStepAttemptParamsSchema.extend({
  itemId: z.string().uuid(),
});

// --- Query ---
export const RefQuerySchema = z.object({
  ref: z.string().optional(),
});

export const PaginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

// --- Apps ---
export const ProjectAppParamsSchema = ProjectIdParamsSchema.extend({
  appName: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
});

export const ProjectAppVersionParamsSchema = ProjectIdParamsSchema.extend({
  versionId: z.string().uuid(),
});

export const AppPresentationSchema = z.object({
  name: z.string(),
  title: z.string(),
  icon: z.enum(APP_ICON_NAMES),
});

/** Host data an app version declares it reads (ADR 0148). */
export const AppAccessSchema = z.object({
  sessions: z.literal("read").optional(),
});

export const AppSummarySchema = z.object({
  name: z.string(),
  title: z.string(),
  id: z.string().uuid().nullable(),
  activeVersionId: z.string().uuid().nullable(),
  publishedAt: z.string().datetime().nullable(),
  icon: z.enum(APP_ICON_NAMES),
  access: AppAccessSchema,
});

export const AppVersionSchema = z.object({
  id: z.string().uuid(),
  appId: z.string().uuid(),
  appName: z.string(),
  kind: z.enum(["preview", "published"]),
  status: z.enum(["building", "ready", "failed"]),
  commitSha: z.string().nullable(),
  bundleBytes: z.number().nullable(),
  allowedWorkflows: z.array(z.string()).nullable(),
  access: AppAccessSchema,
  error: z.string().nullable(),
  isActive: z.boolean(),
  createdAt: z.string().datetime(),
  readyAt: z.string().datetime().nullable(),
  publishedAt: z.string().datetime().nullable(),
});

export const AppViewStateSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("not_found") }),
  z.object({ state: z.literal("not_published") }),
  z.object({
    state: z.literal("ready"),
    appId: z.string().uuid(),
    versionId: z.string().uuid(),
    // Absolute URL of the guest document for this channel. The mount points
    // its iframe here rather than inlining the bundle: a network-scheme
    // document carries its own CSP, where a srcdoc one would inherit the
    // host shell's and could be blocked by it.
    guestUrl: z.string(),
  }),
]);

export const BuildAppSchema = z.object({
  kind: z.enum(["preview", "published"]),
  commitSha: z
    .string()
    .regex(/^[0-9a-f]{7,64}$/i)
    .optional(),
});

// --- Workflows (discovered, not stored) ---
export const WorkflowCapabilitiesSchema = z.object({
  batchProcessing: z.boolean(),
  cancellation: z.boolean(),
});

export const JsonValueSchema = z.json().meta({ id: "JsonValue" });
// Response-side JSON is untyped, like `Run.input`: the tagged JsonValue
// component is io-differentiated (input-only) and recursive z.json() emits
// $refs the spec bundler cannot resolve in responses.
const JsonOutSchema = z.unknown();

export const SourceRangeSchema = z.object({
  start: z.number(),
  end: z.number(),
  startLine: z.number(),
  startColumn: z.number(),
  endLine: z.number(),
  endColumn: z.number(),
  file: z.string().optional(),
});

export const ParameterInfoSchema = z.object({
  name: z.string(),
  type: z.string(),
  optional: z.boolean(),
  displayName: z.string().optional(),
  description: z.string().optional(),
  defaultValue: z.string().optional(),
  schema: JsonOutSchema.optional(),
});

// --- Triggers ---
export const TriggerModeSchema = z.enum(["sync", "async"]);

export const TriggerKindDisplaySchema = z.object({
  label: z.string().optional(),
  icon: z.string().optional(),
  color: z.string().optional(),
});

/** A binding as attached to the graph's entry node, display resolved. */
export const NodeTriggerBindingSchema = z.object({
  kind: z.string(),
  config: JsonOutSchema,
  where: JsonOutSchema.optional(),
  display: TriggerKindDisplaySchema.optional(),
});

/** A binding as written: a host kind or a project trigger kind (ADR 0171). */
export const WorkflowTriggerBindingSchema = z.object({
  kind: z.string(),
  config: JsonOutSchema,
  where: JsonOutSchema.optional(),
  sourceRange: SourceRangeSchema,
});

export const TriggerKindInfoSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  display: TriggerKindDisplaySchema.optional(),
  modes: z.array(TriggerModeSchema),
  payloadJsonSchema: JsonOutSchema,
  configJsonSchema: JsonOutSchema,
  outputJsonSchema: JsonOutSchema.optional(),
});

export const TriggerBindingInfoSchema = z.object({
  workflowName: z.string(),
  /** The host kind that fires the binding. */
  kind: z.string(),
  config: JsonOutSchema,
  /** Filters the payload must satisfy, all of them (ADR 0171). */
  where: z.array(JsonOutSchema),
  /** The project trigger kind the workflow bound. */
  projectKind: z.string().optional(),
  canSuspend: z.boolean(),
  inputParameters: z.array(ParameterInfoSchema),
  inputSchema: JsonOutSchema,
  outputSchema: JsonOutSchema,
});

export const WorkflowEnablementOwnerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("member"), externalUserId: z.string().min(1) }),
  z.object({ type: z.literal("project") }),
]);

export const WorkflowEnablementConnectionSchema = z.object({
  alias: z.string(),
  connectionId: z.string().uuid(),
  providerKind: z.string(),
  principalKind: z.enum(["member", "project_service", "tenant_service"]),
  capabilities: z.array(z.string()),
});

export const WorkflowEnablementTriggerSchema = z.object({
  id: z.string().uuid(),
  definitionId: z.string().uuid(),
  kind: z.string(),
  config: JsonOutSchema,
  projectKind: z.string().optional(),
  status: z.enum(["active", "paused"]),
});

const WorkflowEnablementTargetSchema = z.object({
  projectId: z.string().uuid(),
  workflowName: z.string(),
  deploymentArtifactId: z.string().uuid(),
  commitSha: z.string(),
  remoteBranch: z.string(),
  environment: z.string(),
  owner: WorkflowEnablementOwnerSchema,
  connections: z.array(WorkflowEnablementConnectionSchema),
  capabilities: z.array(z.string()),
  /** Project permissions the workflow declares (ADR 0158). */
  permissions: z.array(z.string()),
  consentDigest: z.string().length(64),
});

export const WorkflowEnablementPreviewSchema =
  WorkflowEnablementTargetSchema.extend({
    deploymentArtifactDigest: z.string(),
    triggerCount: z.number().int().nonnegative(),
    triggers: z.array(
      z.object({
        kind: z.string(),
        config: JsonOutSchema,
        projectKind: z.string().optional(),
      }),
    ),
    connectionLabels: z.record(z.string(), z.string()),
  });

export const WorkflowEnablementSchema = WorkflowEnablementTargetSchema.extend({
  id: z.string().uuid(),
  status: z.enum(["active", "suspended", "disabled"]),
  suspensionReason: z.string().nullable(),
  updateAvailable: z.boolean(),
  temporary: z.boolean(),
  expiresAt: z.string().datetime().nullable(),
  revision: z.number().int().positive(),
  triggers: z.array(WorkflowEnablementTriggerSchema),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const WorkflowSummarySchema = z.object({
  name: z.string(),
  capabilities: WorkflowCapabilitiesSchema,
  displayName: z.string().nullable(),
  description: z.string().nullable(),
  filePath: z.string(),
  parameterCount: z.number(),
  triggers: z.array(WorkflowTriggerBindingSchema),
  canSuspend: z.boolean(),
});

// --- Projects ---
export const ProjectSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  storageType: z.enum(["managed", "remote"]),
  remoteUrl: z.string().nullable(),
  /**
   * Who created the linked remote (ADR 0170). `attached`: Work only pushes
   * `work/*` branches there and shares changes as pull requests. `owned`:
   * Work created it and sync keeps it converged. `null` when unlinked.
   */
  remoteOwnership: z.enum(["owned", "attached"]).nullable(),
  /**
   * Since when the project's main has not been a fast-forward of its code
   * host's default branch (ADR 0170): accepted changes stop arriving until
   * the two are reconciled. `null` while they converge.
   */
  remoteDivergedAt: z.string().datetime().nullable(),
  defaultBranch: z.string(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

// Deliberately no rootPath/importExisting here: explicit filesystem locations
// are a library-direct capability for single-machine hosts, never something a
// remote HTTP client may choose.
export const CreateProjectSchema = z.object({
  name: z.string().min(1),
});

export const UpdateProjectSchema = z.object({
  name: z.string().min(1).optional(),
});

export const ProjectDetailSchema = ProjectSchema.extend({
  workflows: z.array(WorkflowSummarySchema),
  files: z.array(z.string()),
});

// --- Files ---
export const FileEntrySchema = z.object({
  path: z.string(),
  size: z.number(),
});

export const FileContentSchema = z.object({
  path: z.string(),
  content: z.string(),
});

export const WriteFileSchema = z.object({
  content: z.string(),
  expectedContent: z.string().optional(),
  commitMessage: z.string().optional(),
});

// Keep these enums in sync with `@catamorphic/parser`'s `WorkflowNodeType` and
// edge `type` literal union so the OpenAPI-derived types line up with the
// parser's in-memory types and `layoutGraph` can consume the response
// directly with no casts.
export const WorkflowNodeTypeSchema = z.enum([
  "input",
  "source",
  "sink",
  "step",
  "branch",
  "if-block",
  "loop-block",
  "parallel-block",
  "scope-block",
  "durable-boundary",
  "batch",
  "pause",
  "call-workflow",
  "return",
]);

export const WorkflowEdgeTypeSchema = z.enum([
  "branch-false",
  "branch-true",
  "sequential",
]);

// The graph schemas below mirror `@catamorphic/parser`'s `WorkflowGraph`
// exactly so that the OpenAPI-derived response types align with the parser's
// in-memory types and `layoutGraph(...)` can consume responses without any
// adapter.
export const StepArgumentSourceSchema = z.object({
  variable: z.string(),
  variableDisplayName: z.string().optional(),
  stepNodeId: z.string().optional(),
  stepLabel: z.string().optional(),
});

export const StepArgumentSchema = z.object({
  name: z.string(),
  displayName: z.string().optional(),
  value: z.string(),
  source: StepArgumentSourceSchema.optional(),
});

export const WorkflowNodeSchema = z.object({
  id: z.string(),
  type: WorkflowNodeTypeSchema,
  label: z.string(),
  description: z.string().optional(),
  sourceRange: SourceRangeSchema,
  metadata: z.record(z.string(), z.string()),
  parameters: z.array(ParameterInfoSchema).optional(),
  arguments: z.array(StepArgumentSchema).optional(),
  condition: z.string().optional(),
  loopVariable: z.string().optional(),
  loopIterable: z.string().optional(),
  duration: z.string().optional(),
  stateExpression: z.string().optional(),
  workflowName: z.string().optional(),
  workflowInputExpression: z.string().optional(),
  returnExpression: z.string().optional(),
  functionName: z.string().optional(),
  parentId: z.string().optional(),
  triggerBindings: z.array(NodeTriggerBindingSchema).optional(),
});

export const WorkflowEdgeSchema = z.object({
  id: z.string(),
  source: z.string(),
  target: z.string(),
  label: z.string().optional(),
  type: WorkflowEdgeTypeSchema,
});

export const WorkflowGraphSchema = z.object({
  name: z.string(),
  capabilities: WorkflowCapabilitiesSchema,
  displayName: z.string().optional(),
  description: z.string().optional(),
  controls: z.object({ cancel: z.literal(true).optional() }).optional(),
  filePath: z.string().optional(),
  input: z.object({ parameters: z.array(ParameterInfoSchema) }),
  inputSchema: JsonOutSchema,
  outputSchema: JsonOutSchema,
  triggers: z.array(WorkflowTriggerBindingSchema),
  connections: z.array(
    z.object({
      alias: z.string(),
      principal: z.enum(["member", "service", "either"]).optional(),
      capabilities: z.array(z.string()).optional(),
      optional: z.boolean().optional(),
    }),
  ),
  permissions: z.array(z.string()),
  canSuspend: z.boolean(),
  nodes: z.array(WorkflowNodeSchema),
  edges: z.array(WorkflowEdgeSchema),
  sourceCode: z.string(),
});

export const WorkflowDetailSchema = WorkflowGraphSchema.extend({
  projectFiles: z.array(z.string()),
  allFiles: z.record(z.string(), z.string()),
});

// --- Runs ---
export const RunStatusSchema = z.enum([
  "pending",
  "running",
  "waiting",
  "paused",
  "canceling",
  "completed",
  "failed",
  "canceled",
]);

export const RunPhaseSchema = z.enum([
  "execute",
  "boundary",
  "source",
  "process",
  "sink",
  "pause",
  "child",
]);

export const RunCapabilitiesSchema = z.object({
  cancel: z.boolean(),
  pauseProcessing: z.boolean(),
  resumeProcessing: z.boolean(),
  submitInput: z.boolean(),
  inspectItems: z.boolean(),
});

export const RunPauseSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(["open", "resumed", "timed_out", "canceled"]),
  state: z.unknown().nullable(),
  timeoutAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  resolvedAt: z.string().datetime().nullable(),
});

export const BatchProgressSchema = z.object({
  workflowStepAttemptId: z.string().uuid(),
  stepIndex: z.number().int().nonnegative(),
  nodeId: z.string(),
  attempt: z.number().int().positive(),
  status: z.enum([
    "pending",
    "running",
    "waiting",
    "completed",
    "failed",
    "canceled",
  ]),
  estimated: z.number().nullable(),
  discovered: z.number(),
  succeeded: z.number(),
  failed: z.number(),
  skipped: z.number(),
  sinkCompletedChunks: z.number(),
  sinkTotalChunks: z.number(),
  artifact: z.unknown().nullable(),
});

export const RunSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  workflowName: z.string(),
  correlationKey: z.string().nullable(),
  environment: z.string().nullable(),
  allocationId: z.string().uuid().nullable(),
  capabilities: RunCapabilitiesSchema,
  status: RunStatusSchema,
  phase: RunPhaseSchema,
  currentStepIndex: z.number().int().nonnegative().nullable(),
  activePause: RunPauseSchema.nullable(),
  connectionActionRequired: z
    .object({
      id: z.string().uuid(),
      environment: z.string(),
      alias: z.string(),
      status: z.literal("pending"),
      createdAt: z.string().datetime(),
    })
    .nullable(),
  batchScopes: z.array(BatchProgressSchema),
  provenance: z.object({
    commitSha: z.string().optional(),
    /** The workflow's display name at that commit. */
    displayName: z.string().optional(),
  }),
  artifact: z.object({ deploymentArtifactId: z.string().uuid() }).optional(),
  initiatedBy: z.string().nullable(),
  input: z.unknown().nullable(),
  result: z.unknown().nullable(),
  error: z.string().nullable(),
  parentRunId: z.string().uuid().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
});

export const RunStepSchema = z.object({
  id: z.string().uuid(),
  runId: z.string().uuid(),
  nodeId: z.string(),
  occurrence: z.number().int().nonnegative(),
  attempt: z.number().int().positive(),
  name: z.string(),
  status: z.enum(["pending", "running", "completed", "failed", "skipped"]),
  input: z.unknown().nullable(),
  output: z.unknown().nullable(),
  error: z.string().nullable(),
  startedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
});

export const WorkflowStepAttemptSchema = z.object({
  id: z.string().uuid(),
  runId: z.string().uuid(),
  stepIndex: z.number().int().nonnegative(),
  nodeId: z.string(),
  executor: z.enum(["boundary", "batch"]),
  attempt: z.number().int().positive(),
  status: z.enum([
    "pending",
    "running",
    "waiting",
    "completed",
    "failed",
    "canceled",
  ]),
  input: z.unknown().nullable(),
  output: z.unknown().nullable(),
  error: z.string().nullable(),
  startedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
});

export const RunDetailSchema = RunSchema.extend({
  steps: z.array(RunStepSchema),
  workflowStepAttempts: z.array(WorkflowStepAttemptSchema),
});

export const CorrelationKeySchema = z.string().min(1).max(500);

export const EnrollmentConflictPolicySchema = z.enum([
  "ignore",
  "error",
  "restart",
]);

export const TriggerRunSchema = z.object({
  input: JsonValueSchema.optional(),
  environment: z.string().min(1).optional(),
  correlationKey: CorrelationKeySchema.optional(),
  onConflict: EnrollmentConflictPolicySchema.optional(),
});

export const EnvironmentListQuerySchema = z.object({
  workload: z.enum(["agent", "workflow"]),
  agentId: z.string().min(1).optional(),
});

export const EnvironmentListSchema = z.object({
  items: z.array(
    z.object({
      name: z.string(),
      label: z.string(),
      description: z.string().optional(),
      available: z.boolean(),
      clientRequired: z.boolean().optional(),
      machineOnline: z
        .boolean()
        .describe(
          "False when no machine for it is online and open to this work, such as a member's computer that is not connected",
        ),
      compatible: z.boolean(),
      preferred: z.boolean(),
      allowed: z.boolean(),
      personalCredentials: z
        .boolean()
        .optional()
        .describe(
          "Present when the Environment allows personal credentials (ADR 0184): whether the caller's own chats placed there would carry their files and may run on their own sign-in",
        ),
      reasons: z.array(z.string()),
      binding: z
        .object({
          trust: z.enum(["local", "managed"]),
          isolation: z.enum(["none", "process", "sandbox"]),
          capabilities: z.array(z.string()),
          resources: z.record(z.string(), z.union([z.number(), z.boolean()])),
        })
        .optional(),
    }),
  ),
  defaultEnvironment: z.string().optional(),
});

export const AuthenticationRequiredSchema = z.object({
  error: z.string(),
  code: z.literal("authentication_required"),
  environment: z.string(),
  requirements: z.array(
    z.object({
      alias: z.string(),
      providerKind: z.string(),
      principalKinds: z.array(
        z.enum(["member", "project_service", "tenant_service"]),
      ),
    }),
  ),
});

export const ConnectionRecordSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid().nullable(),
  providerKind: z.string(),
  principalKind: z.enum(["member", "project_service", "tenant_service"]),
  /** A service connection's name; Environment bindings refer to it. */
  name: z.string().nullable(),
  ownerExternalUserId: z.string().nullable(),
  label: z.string(),
  status: z.enum(["pending", "ready", "expired", "revoked"]),
  account: JsonOutSchema,
  scopes: z.array(z.string()),
  capabilities: z.array(z.string()),
  expiresAt: z.string().datetime().nullable(),
  revision: z.number().int(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

const ConnectionBindingPrincipalStatusSchema = z.object({
  connectionId: z.string().uuid().nullable(),
  principalKind: z.enum(["member", "project_service", "tenant_service"]),
  label: z.string(),
  status: z.enum(["pending", "ready", "expired", "revoked"]),
  account: JsonOutSchema,
  scopes: z.array(z.string()),
});

/** One alias an Environment commits in `.work/project.json` (ADR 0172). */
export const ConnectionBindingSchema = z.object({
  environment: z.string(),
  alias: z.string(),
  provider: z.string(),
  principal: z.enum(["member", "service", "either"]),
  /** The service connection's name; shown to connection administrators. */
  service: z.string().nullable(),
  capabilities: z.array(z.string()).nullable(),
  memberConnection: ConnectionBindingPrincipalStatusSchema.nullable(),
  serviceConnection: ConnectionBindingPrincipalStatusSchema.nullable(),
});

export const AuthorizationChallengeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("url"),
    url: z.string().url(),
    expiresAt: z.string().optional(),
  }),
  z.object({
    kind: z.literal("device"),
    verificationUrl: z.string().url(),
    userCode: z.string(),
    expiresAt: z.string().optional(),
  }),
  z.object({
    kind: z.literal("form"),
    fields: z.array(
      z.object({
        name: z.string(),
        label: z.string(),
        secret: z.boolean(),
        required: z.boolean(),
        multiline: z.boolean().optional(),
      }),
    ),
  }),
]);

export const FireTriggerSchema = z.object({
  payload: JsonValueSchema,
  environment: z.string().min(1).optional(),
  mode: TriggerModeSchema.optional(),
  workflows: z.array(z.string().min(1)).max(100).optional(),
  correlationKey: CorrelationKeySchema.optional(),
  onConflict: EnrollmentConflictPolicySchema.optional(),
  budgetMs: z.number().int().min(1_000).max(300_000).optional(),
});

export const RunSuspensionReasonSchema = z.enum([
  "pause",
  "child",
  "paused",
  "backoff",
  "batch",
  "budget",
  "queue",
]);
export const TriggerSuspensionReasonSchema = RunSuspensionReasonSchema;

/** Body of a synchronous call: a trigger plus a wall-clock budget. */
export const CallRunSchema = TriggerRunSchema.extend({
  budgetMs: z.number().int().min(1_000).max(300_000).optional(),
});

/**
 * How a synchronous call settled. Discriminated on `status`; `suspended`
 * means the run is still live and can be polled by `runId`.
 */
export const RunCallOutcomeSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("completed"),
    runId: z.string(),
    output: JsonOutSchema,
  }),
  z.object({
    status: z.literal("failed"),
    runId: z.string(),
    error: z.string(),
  }),
  z.object({
    status: z.literal("suspended"),
    runId: z.string(),
    suspendedOn: RunSuspensionReasonSchema,
  }),
]);

export const TriggerFireOutcomeSchema = z.object({
  workflowName: z.string(),
  runId: z.string(),
  status: z.enum(["started", "completed", "failed", "suspended"]),
  output: JsonOutSchema.optional(),
  error: z.string().optional(),
  suspendedOn: TriggerSuspensionReasonSchema.optional(),
});

export const TriggerFireResultSchema = z.object({
  kind: z.string(),
  mode: TriggerModeSchema,
  commitSha: z.string().nullable(),
  runs: z.array(TriggerFireOutcomeSchema),
});

export const SyncTriggerTypesResultSchema = z.object({
  paths: z.array(z.string()),
  updated: z.boolean(),
});

export const RunsQuerySchema = PaginationQuerySchema.extend({
  correlationKey: CorrelationKeySchema.optional(),
});

export const SignalRunSchema = z.object({
  correlationKey: CorrelationKeySchema,
  signal: z.string().min(1).max(255),
  idempotencyKey: z.string().min(1).max(255),
  value: JsonValueSchema,
});

export const CancelRunByKeySchema = z.object({
  correlationKey: CorrelationKeySchema,
  reason: z.string().max(1000).optional(),
});

export const TenantExecutionPolicySchema = z.object({
  tenantId: z.string().uuid(),
  maxConcurrentJobs: z.number().int().positive().optional(),
  maxActiveRuns: z.number().int().positive().optional(),
  queueWeight: z.number().int().min(1).max(1000),
  jobsEnabled: z.boolean(),
  rateLimitOverrides: z.record(
    z.string(),
    z.object({
      capacity: z.number().positive().optional(),
      refillRatePerSecond: z.number().positive().optional(),
    }),
  ),
});

export const UpsertTenantExecutionPolicySchema = z.object({
  maxConcurrentJobs: z.number().int().positive().optional(),
  maxActiveRuns: z.number().int().positive().optional(),
  queueWeight: z.number().int().min(1).max(1000).optional(),
  jobsEnabled: z.boolean().optional(),
  rateLimitOverrides: z
    .record(
      z.string(),
      z.object({
        capacity: z.number().positive().optional(),
        refillRatePerSecond: z.number().positive().optional(),
      }),
    )
    .optional(),
});

export const BatchItemStatusSchema = z.enum([
  "pending",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "skipped",
  "canceled",
]);

export const BatchItemSchema = z.object({
  id: z.string().uuid(),
  runId: z.string().uuid(),
  workflowStepAttemptId: z.string().uuid(),
  key: z.string(),
  sourceOrder: z.number(),
  status: BatchItemStatusSchema,
  value: z.unknown().nullable(),
  output: z.unknown().nullable(),
  error: z.string().nullable(),
  currentNodeId: z.string().nullable(),
  attempt: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
});

export const BatchItemStepSchema = z.object({
  id: z.string().uuid(),
  itemId: z.string().uuid(),
  nodeId: z.string(),
  occurrence: z.number(),
  attempt: z.number(),
  name: z.string(),
  status: z.string(),
  input: z.unknown().nullable(),
  output: z.unknown().nullable(),
  error: z.string().nullable(),
  startedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
});

export const CancelRunSchema = z.object({
  reason: z.string().max(1000).optional(),
});

export const ResumeRunPauseSchema = z.object({
  idempotencyKey: z.string().min(1).max(255),
  value: JsonValueSchema,
});

export const RunItemsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
  status: BatchItemStatusSchema.optional(),
});

// --- Git ---
export const CommitSchema = z.object({
  sha: z.string(),
  message: z.string(),
  author: z.object({ name: z.string(), email: z.string() }),
  timestamp: z.number(),
});

export const SetRemoteSchema = z.object({
  url: z.string().url(),
});

export const RepoStatusSchema = z.object({
  branch: z.string(),
  dirty: z.boolean(),
  modifiedFiles: z.array(z.string()),
  ahead: z.number(),
  behind: z.number(),
  baseCommit: z.string().nullable(),
  remoteHead: z.string().nullable(),
  remoteHeadTimestamp: z.number().nullable(),
});

export const DiffEntrySchema = z.object({
  path: z.string(),
  kind: z.enum(["added", "modified", "deleted"]),
  before: z.string().nullable(),
  after: z.string().nullable(),
});

export const ConflictEntrySchema = z.object({
  path: z.string(),
  base: z.string().nullable(),
  ours: z.string().nullable(),
  theirs: z.string().nullable(),
  /** A file that is not text: its sides are not rendered as text. */
  binary: z.boolean().optional(),
});

export const DeployRequestSchema = z.object({
  message: z.string().min(1).optional(),
  /**
   * Files to publish as one commit on top of the published program, leaving
   * the member's draft untouched (ADR 0191).
   */
  files: z.record(z.string(), z.string()).optional(),
  /**
   * The published commit `files` were edited from: files changed on the
   * server since merge with them, or come back as conflicts.
   */
  base: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .optional(),
});

export const PullRequestSchema = z.object({
  /** Files to write into the member's draft before merging. */
  files: z.record(z.string(), z.string()).optional(),
});

export const DeployResponseSchema = z.object({
  status: z.enum(["deployed", "nothing-to-deploy", "conflict"]),
  commitSha: z.string().nullable(),
  remoteSha: z.string().nullable(),
  conflicts: z.array(ConflictEntrySchema),
});

export const PullResponseSchema = z.object({
  status: z.enum(["clean", "conflict", "up-to-date"]),
  mergeCommit: z.string().nullable(),
  conflicts: z.array(ConflictEntrySchema),
});

export const DiscardResponseSchema = z.object({
  discarded: z.boolean(),
  branch: z.string(),
});

export const ResolveConflictsSchema = z.object({
  resolutions: z.record(z.string(), z.string()),
  message: z.string().optional(),
});

// --- Users ---
export const UserSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  displayName: z.string(),
  createdAt: z.string().datetime(),
});

// --- Project Members ---
export const ProjectMemberSchema = z.object({
  projectId: z.string().uuid(),
  userId: z.string().uuid(),
  role: z.enum(["owner", "editor", "viewer"]),
  createdAt: z.string().datetime(),
});

// --- Sandboxes ---
export const SandboxSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  provider: z.string(),
  providerId: z.string(),
  sandboxType: z.enum(["execution", "dev"]),
  commitSha: z.string().length(40).nullable(),
  userId: z.string().uuid().nullable(),
  status: z.string(),
  snapshotName: z.string().nullable(),
  createdAt: z.string().datetime(),
  lastUsedAt: z.string().datetime(),
});

// --- Agent Sessions ---
export const AgentEffortSchema = z.enum([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export const AgentTodoStatusSchema = z.enum([
  "pending",
  "in_progress",
  "completed",
]);

export const AgentTodoSchema = z.object({
  id: z.string().uuid(),
  title: z.string().min(1).max(200),
  description: z.string().min(1).max(4_000),
  status: AgentTodoStatusSchema,
  /** What the agent does while this is in progress ("Reviewing migrations"). */
  activeForm: z.string().max(200).optional(),
});

export const AgentSessionSourceSchema = z.enum([
  "desktop",
  "mobile",
  "slack",
  "claude",
  "mcp",
  "api",
]);

export const AgentSessionsQuerySchema = PaginationQuerySchema.extend({
  visibility: z.enum(["promoted", "latent", "archived"]).optional(),
  parentSessionId: z.string().uuid().optional(),
  rootsOnly: z
    .enum(["true", "false"])
    .transform((value) => value === "true")
    .optional(),
}).refine((value) => !(value.rootsOnly && value.parentSessionId), {
  message: "Choose rootsOnly or parentSessionId, not both.",
});

/**
 * A chat named by the project's key (ADR 0173): the caller's own, the
 * project chat with `audience=project`, or a member's with `member=<id>`.
 */
export const KeyedChatParamsSchema = ProjectIdParamsSchema.extend({
  key: z.string().trim().min(1).max(200),
});
export const KeyedChatQuerySchema = z
  .object({
    audience: z.literal("project").optional(),
    member: z.string().min(1).optional(),
  })
  .refine((value) => !(value.audience && value.member), {
    message: "Choose audience=project or member, not both.",
  });
export const ClosedKeyedChatSchema = z.object({
  sessionId: z.string().uuid().nullable(),
  closed: z.boolean(),
});

/**
 * Where a chat's workspace starts, or moves to (ADR 0178): a branch, tag,
 * commit, or full ref (`refs/pull/42/head`) of the project's linked remote.
 */
export const SessionWorkspaceRequestBodySchema = z.strictObject({
  ref: z.string().trim().min(1).max(255),
  update: z.enum(["reset", "rebase"]).optional(),
});

/** The base a chat's workspace stands on (ADR 0178). */
export const SessionWorkspaceSchema = z.object({
  ref: z.string(),
  commit: z.string(),
});

export const AgentSessionPlacementSchema = z.object({
  environment: z.string(),
  reason: z.enum([
    "requested",
    "agent_preferred",
    "project_default",
    "available",
  ]),
  machine: z.object({ id: z.string(), label: z.string() }),
});

export const AgentSessionSchema = z.object({
  workStatus: z.enum(["open", "completed"]),
  stateRevision: z.number().int().nonnegative(),
  childCount: z.number().int().nonnegative().optional(),
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  externalUserId: z.string(),
  owner: z.enum(["member", "project"]),
  source: AgentSessionSourceSchema,
  sandboxId: z.string().uuid().nullable(),
  environment: z.string().nullable(),
  allocationId: z.string().uuid().nullable(),
  agentId: z.string().nullable(),
  model: z.string().nullable(),
  modelEffort: AgentEffortSchema.nullable(),
  title: z.string().nullable(),
  icon: z.string().nullable(),
  forkedFromSessionId: z.string().uuid().nullable(),
  parentSessionId: z.string().uuid().nullable(),
  visibility: z.enum(["latent", "promoted", "archived"]),
  archivedAt: z.string().datetime().nullable(),
  status: z.enum(["active", "closed"]),
  activity: z.string().nullable(),
  todos: z.array(AgentTodoSchema).max(50),
  authorityHostId: z.string().min(1),
  authorityRevision: z.number().int().positive(),
  authoritySeenAt: z.string().datetime(),
  /** The last event sequence a mirror pushed here (ADR 0196). */
  mirrorSequence: z.number().int().nonnegative(),
  handoffStatus: z.enum(["none", "pending"]),
  handoffDestinationHostId: z.string().nullable(),
  resumable: z.boolean(),
  pausedAt: z.string().datetime().nullable(),
  running: z.boolean(),
  attentionRevision: z.number().int().nonnegative(),
  attentionSeenRevision: z.number().int().nonnegative(),
  attentionRequired: z.boolean(),
  attentionMessage: z
    .object({ id: z.string().uuid(), content: z.string() })
    .optional(),
  /** The project's key for this chat (ADR 0173); closing frees it. */
  key: z.string().nullable(),
  /** Workflows that delivered to the chat by its key. */
  keyWorkflows: z.array(z.string()),
  /** Where the chat runs and why (ADR 0173). */
  placement: AgentSessionPlacementSchema.nullable(),
  /** The base the chat's workspace stands on (ADR 0178). */
  workspace: SessionWorkspaceSchema.nullable(),
  baseCommitSha: z.string().length(40).nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const AgentSessionIdParamsSchema = ProjectIdParamsSchema.extend({
  sessionId: z.string().uuid(),
});

export const AgentSessionPeerSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  title: z.string().nullable(),
  agentId: z.string().nullable(),
  parentSessionId: z.string().uuid().nullable(),
  forkedFromSessionId: z.string().uuid().nullable(),
  visibility: z.enum(["latent", "promoted", "archived"]),
  status: z.enum(["active", "closed"]),
  running: z.boolean(),
  task: z.string().max(240).nullable(),
  activity: z.string().max(500).nullable(),
  updatedAt: z.string().datetime(),
});

export const UpdateAgentSessionActivitySchema = z.object({
  activity: z.string().max(500).nullable(),
});

export const CreateAgentSessionSchema = z.object({
  systemPrompt: z.string().optional(),
  /** Host-registry key of the agent to run this session on. */
  agentId: z.string().optional(),
  model: z.string().optional(),
  effort: AgentEffortSchema.optional(),
  environment: z.string().min(1).optional(),
  /** Surface creating the session. Provenance only; never grants access. */
  source: AgentSessionSourceSchema.optional(),
  parentSessionId: z.string().uuid().optional(),
  title: z.string().min(1).max(500).optional(),
  /** Start the workspace at a ref of the project's linked remote. */
  workspace: SessionWorkspaceRequestBodySchema.optional(),
});

export const CreateAgentSubsessionSchema = z.object({
  routeId: z.string().min(1).max(100).optional(),
  agentId: z.string().min(1).optional(),
  task: z.string().min(1).max(100_000),
  contextMode: z.enum(["fresh", "inherit"]).optional(),
  title: z.string().min(1).max(500).optional(),
});

export const AgentSubsessionSchema = z.object({
  delegationId: z.string().uuid(),
  routeId: z.string(),
  task: z.string(),
  contextMode: z.enum(["fresh", "inherit"]),
  allowFurtherDelegation: z.boolean(),
  status: z.enum(["running", "completed", "failed", "interrupted", "archived"]),
  session: AgentSessionSchema,
});

export const WaitForAgentSubsessionsSchema = z.object({
  sessionIds: z.array(z.string().uuid()).max(100).optional(),
  timeoutMs: z.number().int().min(0).max(60_000).optional(),
});

export const ArchiveAgentSessionSchema = z.object({
  confirmStop: z.boolean().optional(),
});

export const AgentSessionArchiveImpactSchema = z.object({
  sessionIds: z.array(z.string().uuid()),
  runningSessionIds: z.array(z.string().uuid()),
  watchers: z.array(
    z.object({
      id: z.string().uuid(),
      sessionId: z.string().uuid(),
      name: z.string(),
      environment: z.string().nullable(),
      nextRunAt: z.string().nullable(),
    }),
  ),
  activeWatcherCount: z.number().int().nonnegative(),
  activeProcessCount: z.number().int().nonnegative(),
  requiresConfirmation: z.boolean(),
});

export const AgentSessionArchiveResultSchema = z.object({
  impact: AgentSessionArchiveImpactSchema,
  sessions: z.array(AgentSessionSchema),
});

export const AgentSessionArchiveConfirmationSchema = z.object({
  error: z.string(),
  code: z.literal("archive_confirmation_required"),
  impact: AgentSessionArchiveImpactSchema,
});

export const AgentSubsessionIdParamsSchema = AgentSessionIdParamsSchema.extend({
  childSessionId: z.string().uuid(),
});

export const UpdateAgentSessionSchema = z.object({
  agentId: z.string().optional(),
  /** `null` clears the override back to the agent harness's default. */
  model: z.string().min(1).max(500).nullable().optional(),
  /** `null` clears the override back to the agent's default. */
  effort: AgentEffortSchema.nullable().optional(),
  environment: z.string().min(1).optional(),
});

export const EnvironmentErrorSchema = z.object({
  error: z.string(),
  code: z.string(),
  reasons: z.array(z.string()).optional(),
});

// --- Agent session log (ADR 0196) ---
//
// The wire shapes of `@catamorphic/agent-protocol`. Each schema is bound to
// its protocol type with `describes`, so a change on either side that the
// other does not follow fails the typecheck here.

/**
 * Bind a schema to the protocol type it describes: the schema's output must
 * be assignable to the type and the type to the schema's output.
 */
function describes<T>() {
  return <S extends z.ZodType<T>>(
    schema: S & ([T] extends [z.output<S>] ? unknown : never),
  ): S => schema;
}

// The protocol's own JSON value (inside a `respond` command) is recursive;
// naming it lets the OpenAPI document reference it instead of an anonymous
// cycle.
z.globalRegistry.add(jsonValueSchema, { id: "ProtocolJsonValue" });

export const DispatchModeSchema = describes<DispatchMode>()(
  dispatchModeSchema.describe(
    "queue: a new turn after the active one; steer: join the active turn; interrupt: stop the active turn and run this next; message_only: record it without starting a turn",
  ),
);

export const SessionMessageAuthorSchema = describes<SessionMessageAuthor>()(
  sessionMessageAuthorSchema,
);

const JsonObjectSchema = describes<JsonObject>()(
  z.record(z.string(), JsonValueSchema),
);

const NativeRefSchema = describes<NativeRef>()(
  z.object({
    id: z.string(),
    strength: z.enum(["strong", "weak", "none"]),
  }),
);

const TurnErrorSchema = describes<TurnError>()(
  z.object({
    message: z.string(),
    kind: z
      .enum(["auth", "rate_limit", "unavailable", "model_incompat"])
      .optional(),
    retrySafe: z.boolean().optional(),
  }),
);

const AgentTurnUsageSchema = describes<AgentTurnUsage>()(
  z.object({
    model: z.string().optional(),
    inputTokens: z.number().optional(),
    cachedInputTokens: z.number().optional(),
    cacheCreationTokens: z.number().optional(),
    outputTokens: z.number().optional(),
    reasoningTokens: z.number().optional(),
    costUsd: z.number().optional(),
    contextTokens: z.number().optional(),
    contextWindow: z.number().optional(),
  }),
);

const TurnOutcomeSchema = describes<TurnOutcome>()(
  z.object({
    changedFiles: z.array(
      z.object({ path: z.string(), kind: z.enum(["modified", "deleted"]) }),
    ),
    usage: AgentTurnUsageSchema.optional(),
    storeSync: JsonObjectSchema.optional(),
    workspaceSync: z.object({ error: z.string() }).optional(),
    notification: z
      .object({ title: z.string().optional(), body: z.string().optional() })
      .optional(),
  }),
);

export const TurnSchema = describes<Turn>()(
  z
    .object({
      id: z.string(),
      sessionId: z.string(),
      ordinal: z.number().int(),
      status: z.enum([
        "queued",
        "held",
        "preparing",
        "running",
        "waiting",
        "finalizing",
        "completed",
        "failed",
        "interrupted",
        "cancelled",
        "rolled_back",
      ]),
      inputItemId: z.string().nullable(),
      dispatch: z.enum(["queue", "interrupt"]),
      priority: z.number(),
      activity: z.string().nullable(),
      activityAt: z.string().nullable(),
      attemptCount: z.number().int(),
      activeAttemptId: z.string().nullable(),
      providerThreadId: z.string().nullable(),
      retryAt: z.string().nullable(),
      cancellationRequested: z.boolean(),
      error: TurnErrorSchema.nullable(),
      outcome: TurnOutcomeSchema.nullable(),
      checkpoint: z.object({
        before: z.string().nullable(),
        after: z.string().nullable(),
      }),
      continuationOf: z.string().nullable(),
      createdAt: z.string(),
      startedAt: z.string().nullable(),
      completedAt: z.string().nullable(),
      updatedAt: z.string(),
    })
    .meta({ id: "Turn" }),
);

export const AttemptSchema = describes<Attempt>()(
  z
    .object({
      id: z.string(),
      turnId: z.string(),
      sessionId: z.string(),
      ordinal: z.number().int(),
      reason: z.enum(["initial", "retry", "steer_restart", "recovery"]),
      status: z.enum([
        "preparing",
        "running",
        "completed",
        "failed",
        "interrupted",
        "lost",
        "superseded",
      ]),
      providerThreadId: z.string().nullable(),
      nativeTurnRef: NativeRefSchema.nullable(),
      error: TurnErrorSchema.nullable(),
      createdAt: z.string(),
      startedAt: z.string().nullable(),
      completedAt: z.string().nullable(),
    })
    .meta({ id: "Attempt" }),
);

/** The identity and placement Work assigns every item. */
const itemCommon = {
  id: z.string(),
  sessionId: z.string(),
  turnId: z.string().nullable(),
  attemptId: z.string().nullable(),
  parentItemId: z.string().nullable(),
  position: z.number().int(),
  status: z.enum(["in_progress", "completed", "failed", "cancelled"]),
  nativeRef: NativeRefSchema.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
};

export const ItemSchema = describes<Item>()(
  z
    .discriminatedUnion("kind", [
      z.object({
        ...itemCommon,
        kind: z.literal("user_message"),
        author: SessionMessageAuthorSchema,
        text: z.string(),
        attachments: z.array(attachmentSchema),
        dispatch: DispatchModeSchema,
        attention: z.literal("required").nullable(),
        idempotencyKey: z.string().nullable(),
        metadata: JsonObjectSchema,
      }),
      z.object({
        ...itemCommon,
        kind: z.literal("assistant_message"),
        text: z.string(),
        agentId: z.string().nullable(),
      }),
      z.object({
        ...itemCommon,
        kind: z.literal("reasoning"),
        text: z.string(),
      }),
      z.object({
        ...itemCommon,
        kind: z.literal("tool_call"),
        tool: z.string(),
        server: z.string().nullable(),
        description: z.string().nullable(),
        input: JsonValueSchema,
        result: JsonValueSchema.nullable(),
        error: z.string().nullable(),
      }),
      z.object({
        ...itemCommon,
        kind: z.literal("command"),
        command: z.string(),
        description: z.string().nullable(),
        output: z.string(),
        exitCode: z.number().int().nullable(),
      }),
      z.object({
        ...itemCommon,
        kind: z.literal("file_change"),
        path: z.string(),
        change: z
          .enum(["created", "modified", "deleted", "renamed"])
          .nullable(),
        previousPath: z.string().nullable(),
      }),
      z.object({
        ...itemCommon,
        kind: z.literal("plan"),
        steps: z.array(
          z.object({
            text: z.string(),
            status: z.enum(["pending", "in_progress", "completed"]),
          }),
        ),
      }),
      z.object({
        ...itemCommon,
        kind: z.literal("request"),
        requestId: z.string(),
      }),
      z.object({
        ...itemCommon,
        kind: z.literal("subagent"),
        title: z.string(),
        agentType: z.string().nullable(),
        childSessionId: z.string().nullable(),
        result: z.string().nullable(),
      }),
      z.object({
        ...itemCommon,
        kind: z.literal("notice"),
        code: z.string(),
        text: z.string(),
        data: JsonObjectSchema,
      }),
      z.object({
        ...itemCommon,
        kind: z.literal("context_handoff"),
        strategy: z.enum(["delta", "full"]),
        fromProviderThreadIds: z.array(z.string()),
        toProviderThreadId: z.string(),
        coveredTurnOrdinals: z.object({
          from: z.number().int(),
          to: z.number().int(),
        }),
        text: z.string(),
      }),
    ])
    .meta({ id: "Item" }),
);

/** An answer to a runtime request; the protocol's own schema, typed exactly. */
const RuntimeRequestResponseSchema = describes<RuntimeRequestResponse>()(
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("approval"),
      decision: z.enum(["approved", "denied"]),
      remember: z.literal("always").optional(),
    }),
    z.object({ kind: z.literal("question"), answers: z.array(z.string()) }),
    z.object({
      kind: z.literal("elicitation"),
      action: z.enum(["accept", "decline", "cancel"]),
      content: JsonValueSchema.optional(),
    }),
  ]),
);

export const RuntimeRequestSchema = describes<RuntimeRequest>()(
  z
    .object({
      id: z.string(),
      sessionId: z.string(),
      turnId: z.string().nullable(),
      attemptId: z.string().nullable(),
      itemId: z.string().nullable(),
      kind: z.enum(["question", "approval", "elicitation"]),
      status: z.enum(["pending", "resolved", "expired", "cancelled"]),
      answerable: z.boolean(),
      blocking: z.boolean(),
      title: z.string(),
      description: z.string().nullable(),
      origin: z.object({
        kind: z.enum(["tool", "provider", "mcp", "host"]),
        id: z.string(),
        displayName: z.string().optional(),
      }),
      questions: z
        .array(
          z.object({
            question: z.string(),
            header: z.string(),
            multiSelect: z.boolean(),
            options: z.array(
              z.object({ label: z.string(), description: z.string() }),
            ),
          }),
        )
        .nullable(),
      approval: z
        .object({
          action: z.string(),
          details: z.string().optional(),
          tool: z
            .object({
              server: z.string().nullable(),
              name: z.string(),
              input: JsonValueSchema,
            })
            .optional(),
        })
        .nullable(),
      elicitation: z
        .object({
          server: z.string(),
          message: z.string(),
          schema: JsonObjectSchema.optional(),
          url: z.string().optional(),
        })
        .nullable(),
      approvers: z.array(z.string()),
      expiresAt: z.string().nullable(),
      response: RuntimeRequestResponseSchema.nullable(),
      resolvedBy: z.string().nullable(),
      reason: z.string().nullable(),
      createdAt: z.string(),
      resolvedAt: z.string().nullable(),
      runnerKey: z.string().optional(),
    })
    .meta({ id: "RuntimeRequest" }),
);

export const ProviderThreadSchema = describes<ProviderThread>()(
  z
    .object({
      id: z.string(),
      sessionId: z.string(),
      harness: z.string(),
      nativeRef: NativeRefSchema.nullable(),
      status: z.enum(["active", "unavailable", "closed"]),
      lastTurnOrdinal: z.number().int().nullable(),
      portable: z.boolean(),
      createdAt: z.string(),
      updatedAt: z.string(),
    })
    .meta({ id: "ProviderThread" }),
);

/** A session's shared fields, what every viewer sees alike. */
export const SessionFieldsSchema = describes<SessionFields>()(
  z
    .object({
      id: z.string(),
      projectId: z.string(),
      title: z.string().nullable(),
      icon: z.string().nullable(),
      agentId: z.string().nullable(),
      model: z.string().nullable(),
      modelEffort: AgentEffortSchema.nullable(),
      status: z.enum(["active", "closed"]),
      workStatus: z.enum(["open", "completed"]),
      activity: z.string().nullable(),
      todos: z.array(AgentTodoSchema),
      parentSessionId: z.string().nullable(),
      forkedFromSessionId: z.string().nullable(),
      attentionRevision: z.number().int(),
      environment: z.string().nullable(),
      authorityHostId: z.string(),
      authorityRevision: z.number().int(),
      handoffStatus: z.enum(["none", "pending"]),
      updatedAt: z.string(),
    })
    .meta({ id: "SessionFields" }),
);

export const SessionEventSchema = describes<SessionEvent>()(
  z
    .discriminatedUnion("type", [
      z.object({
        type: z.literal("session.changed"),
        session: SessionFieldsSchema.partial(),
      }),
      z.object({ type: z.literal("turn.changed"), turn: TurnSchema }),
      z.object({ type: z.literal("attempt.changed"), attempt: AttemptSchema }),
      z.object({ type: z.literal("item.added"), item: ItemSchema }),
      z.object({ type: z.literal("item.changed"), item: ItemSchema }),
      z.object({
        type: z.literal("item.text_appended"),
        itemId: z.string(),
        field: z.enum(["text", "output"]),
        text: z.string(),
        at: z.string(),
      }),
      z.object({
        type: z.literal("request.changed"),
        request: RuntimeRequestSchema,
      }),
      z.object({
        type: z.literal("provider_thread.changed"),
        thread: ProviderThreadSchema,
      }),
    ])
    .meta({ id: "SessionEvent" }),
);

export const StoredSessionEventSchema = describes<StoredSessionEvent>()(
  z
    .object({
      sessionId: z.string(),
      sequence: z.number().int().positive(),
      at: z.string(),
      commandId: z.string().nullable(),
      event: SessionEventSchema,
    })
    .meta({ id: "StoredSessionEvent" }),
);

export const SessionSnapshotSchema = describes<SessionSnapshot>()(
  z
    .object({
      sequence: z.number().int().nonnegative(),
      session: SessionFieldsSchema,
      turns: z.array(TurnSchema),
      attempts: z.array(AttemptSchema),
      items: z.array(ItemSchema),
      requests: z.array(RuntimeRequestSchema),
      providerThreads: z.array(ProviderThreadSchema),
      olderBefore: z.number().int().nullable(),
    })
    .meta({ id: "SessionSnapshot" }),
);

/** One server-sent event of `GET …/events`, as its `data:` JSON. */
export const SessionStreamMessageSchema = describes<SessionStreamMessage>()(
  z
    .discriminatedUnion("type", [
      z.object({
        type: z.literal("events"),
        events: z.array(StoredSessionEventSchema),
      }),
      z.object({ type: z.literal("reset"), snapshot: SessionSnapshotSchema }),
      z.object({
        type: z.literal("heartbeat"),
        sequence: z.number().int().nonnegative(),
      }),
    ])
    .meta({ id: "SessionStreamMessage" }),
);

export const CommandReceiptSchema = describes<CommandReceipt>()(
  z
    .object({
      commandId: z.string(),
      status: z.enum(["accepted", "rejected"]),
      sequence: z.number().int().nonnegative(),
      result: JsonObjectSchema.nullable(),
      error: z.object({ code: z.string(), message: z.string() }).nullable(),
    })
    .meta({ id: "CommandReceipt" }),
);

/** A command to a session; resending one `commandId` returns its first receipt. */
export const SessionCommandSchema =
  describes<SessionCommand>()(sessionCommandSchema);

export const AgentSessionDetailSchema = AgentSessionSchema.extend({
  snapshot: SessionSnapshotSchema,
});

export const SessionItemsQuerySchema = z.object({
  /** Items before this position: a snapshot's or page's `olderBefore`. */
  before: z.coerce.number().int().positive(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

export const SessionItemsPageSchema = z.object({
  items: z.array(ItemSchema),
  olderBefore: z.number().int().nullable(),
});

export const SessionEventsQuerySchema = z.object({
  /** Stream events after this sequence: a snapshot's `sequence`. */
  after: z.coerce.number().int().nonnegative().optional(),
});

export const SessionMirrorQuerySchema = z.object({
  /** The copy's last sequence; omitted for a copy that does not exist yet. */
  after: z.coerce.number().int().nonnegative().optional(),
});

/** One workflow-facing session event a mirror carries (ADR 0156). */
const MirrorProjectEventSchema = z.object({
  id: z.string().uuid(),
  kind: z
    .string()
    .regex(/^session\./)
    .max(100),
  occurredAt: z.string().datetime(),
  payload: JsonObjectSchema,
});

/**
 * One mirror push (ADR 0196): the source's log after this copy's sequence,
 * or, for a copy that does not exist yet, a full snapshot to start from.
 */
export const MirrorAgentSessionSchema = z.object({
  authority: z.object({
    hostId: z.string().min(1).max(255),
    revision: z.number().int().positive(),
  }),
  title: z.string().max(500).nullable().optional(),
  icon: z.string().max(100).nullable().optional(),
  /** The surface that originally created the conversation. */
  source: AgentSessionSourceSchema.optional(),
  /**
   * The source session's project-agent slug: the same agent here when
   * this server has it and the caller's role covers it, else the default.
   */
  agentSlug: z.string().max(200).optional(),
  todos: z.array(AgentTodoSchema).max(50).optional(),
  workStatus: z.enum(["open", "completed"]).optional(),
  /** Every turn, item, request and thread at `base.sequence`, for a new copy. */
  base: SessionSnapshotSchema.optional(),
  events: z.array(StoredSessionEventSchema).max(5_000),
  projectEvents: z.array(MirrorProjectEventSchema).max(5_000).optional(),
});

export const MirrorAgentSessionResultSchema = z.object({
  session: AgentSessionSchema,
  /** The copy's last event sequence after the push. */
  sequence: z.number().int().nonnegative(),
  /** Why a newly mirrored chat continues with another agent than the one it ran. */
  agentNotice: z.string().optional(),
});

export const MirrorExportSchema = z.object({
  /** The whole session, when the copy is new or too far behind for events. */
  base: SessionSnapshotSchema.optional(),
  events: z.array(StoredSessionEventSchema),
  projectEvents: z.array(MirrorProjectEventSchema).optional(),
});

/**
 * Why a mirror push was refused: `diverged` (the chat continued here, so
 * stop pushing), `behind` (the copy ends at `sequence`, so resend from
 * there), or `turn_in_progress` (a turn runs here; push when it settles).
 */
export const MirrorConflictSchema = z.discriminatedUnion("code", [
  z.object({ error: z.string(), code: z.literal("diverged") }),
  z.object({
    error: z.string(),
    code: z.literal("behind"),
    sequence: z.number().int().nonnegative(),
  }),
  z.object({ error: z.string(), code: z.literal("turn_in_progress") }),
]);

export const ForkAgentSessionSchema = z.object({
  /**
   * Fork point: the item (ADR 0196) the transcript is copied through,
   * with the turn it belongs to. Omitted = every settled turn.
   */
  messageId: z.string().min(1).max(200).optional(),
});

export const SessionMailboxItemSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  sessionId: z.string().uuid(),
  sourceHostId: z.string(),
  destinationHostId: z.string(),
  authorityRevision: z.number().int().positive(),
  /** The user item the delivery becomes on the destination (ADR 0196). */
  messageId: z.string().uuid(),
  content: z.string(),
  author: SessionMessageAuthorSchema,
  mode: DispatchModeSchema,
  idempotencyKey: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.string().datetime(),
});

export const SessionMailboxListQuerySchema = z.object({
  destinationHostId: z.string().min(1).max(255),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});
export const SessionMailboxListSchema = z.object({
  items: z.array(SessionMailboxItemSchema),
});

export const SessionMailboxIdParamsSchema = ProjectIdParamsSchema.extend({
  mailboxId: z.string().uuid(),
});

export const AcknowledgeSessionMailboxSchema = z.object({
  destinationHostId: z.string().min(1).max(255),
});

export const WatcherSchema = z.object({
  lastRun: z
    .object({
      id: z.string().uuid(),
      status: z.string(),
      error: z.string().nullable(),
    })
    .nullable(),
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  sessionId: z.string().uuid(),
  monitorId: z.string().uuid().nullable(),
  workflowName: z.string(),
  sourcePath: z.string(),
  remoteBranch: z.string(),
  commitSha: z.string().length(40),
  deploymentArtifactId: z.string().uuid(),
  environment: z.string().nullable(),
  triggerKinds: z.array(z.string()),
  cursorSequence: z.number().int().nonnegative(),
  status: z.enum(["active", "paused", "stopped", "expired"]),
  expiresAt: z.string().datetime().nullable(),
  nextRunAt: z.string().datetime().nullable(),
  lastError: z.string().nullable(),
  createdAt: z.string().datetime(),
});

export const WatcherIdParamsSchema = AgentSessionIdParamsSchema.extend({
  watcherId: z.string().uuid(),
});

export const OkSchema = z.object({ ok: z.literal(true) });

// --- Skills ---
export const SkillSchema = z.object({
  name: z.string(),
  /** Human-facing name (frontmatter `title`, else the humanized slug). */
  title: z.string(),
  description: z.string(),
  path: z.string(),
  source: z.enum(["project", "user", "host"]),
});

/** A harness's own permission settings, in its native values (ADR 0182). */
export const HarnessPermissionsSchema = z.object({
  permissionMode: z.enum(CLAUDE_CODE_PERMISSION_MODES).optional(),
  sandbox: z.enum(CODEX_SANDBOX_MODES).optional(),
  approvals: z.enum(CODEX_APPROVAL_POLICIES).optional(),
});

// --- Project agent definitions (ADR 0050) ---
// Committed `.work/agents/<slug>.json` files, parsed and validated by core's
// AgentDefinitionsService. Broken files come back as invalid entries with
// the error — never a failed request.
export const ProjectAgentDefinitionSchema = z.object({
  version: z.number(),
  name: z.string(),
  kind: z.string(),
  model: z.string().optional(),
  effort: AgentEffortSchema.optional(),
  /** What may leave the agent's sandbox (ADR 0182). */
  sandboxing: z.enum(SANDBOXING_LEVELS).optional(),
  /** The harness's own permission mode, in its native values (ADR 0182). */
  harnessPermissions: HarnessPermissionsSchema.optional(),
  memory: z.boolean().optional(),
  description: z.string().optional(),
  credentials: z
    .object({
      source: z.enum(["profile", "secret", "local", "connection", "personal"]),
      secret: z.string().optional(),
      /** The Environment alias of the agent's model connection (ADR 0180). */
      connection: z.string().optional(),
    })
    .optional(),
  connections: z
    .array(
      z.union([
        z.string(),
        z.object({
          alias: z.string(),
          principal: z.enum(["member", "service", "either"]).optional(),
          capabilities: z.array(z.string()).optional(),
          optional: z.boolean().optional(),
        }),
      ]),
    )
    .optional(),
  skills: z.array(z.string()).optional(),
  acp: z
    .object({
      endpoint: z.string().optional(),
      command: z.array(z.string()).optional(),
    })
    .optional(),
});

export const ProjectAgentEntrySchema = z.object({
  slug: z.string(),
  definition: ProjectAgentDefinitionSchema.optional(),
  /** Content of the sibling `.work/agents/<slug>.md` persona file. */
  promptFile: z.string().optional(),
  invalid: z.object({ error: z.string() }).optional(),
});

// --- Roles & memberships (ADR 0055) ---
// The role file schema is core's (`RoleDefinitionSchema`): one definition,
// so the OpenAPI spec and runtime validation can never disagree.
export const RoleDefinitionSchema = CoreRoleDefinitionSchema;

export const ProjectRoleEntrySchema = z.object({
  slug: z.string(),
  definition: RoleDefinitionSchema.optional(),
  invalid: z.object({ error: z.string() }).optional(),
});

export const MembershipSchema = z.object({
  projectId: z.string(),
  externalUserId: z.string(),
  roles: z.array(z.string()),
  grants: z.record(z.string(), z.array(z.string())),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const MembershipParamsSchema = ProjectIdParamsSchema.extend({
  externalUserId: z.string().min(1).max(128),
});

export const GrantMembershipSchema = z.object({
  roles: z.array(z.string().min(1)),
  grants: z.record(z.string().min(1), z.array(z.string())).optional(),
});

// --- Documents (ADR 0055) ---
export const DocumentEntrySchema = z.object({
  path: z.string(),
  source: z.enum(["program", "store"]),
  contentType: z.string(),
  size: z.number(),
  version: z.number().optional(),
  writtenBy: z.string().optional(),
  writtenAt: z.string().optional(),
  digest: z.string().optional(),
  /** Program only: the published commit the listing read (ADR 0191). */
  commit: z.string().optional(),
});

export const DocumentContentSchema = DocumentEntrySchema.extend({
  /** UTF-8 text when the document is text-like; absent for binaries. */
  text: z.string().optional(),
});

export const DocumentVersionSchema = z.object({
  version: z.number(),
  deleted: z.boolean(),
  contentType: z.string(),
  size: z.number(),
  writtenBy: z.string(),
  writtenAt: z.string(),
});

export const DocumentMatchSchema = z.object({
  path: z.string(),
  source: z.enum(["program", "store"]),
  lines: z.array(z.object({ line: z.number(), text: z.string() })),
});

export const WriteDocumentSchema = z
  .object({
    path: z.string().min(1),
    /** UTF-8 text content — or `base64` for bytes; exactly one. */
    text: z.string().optional(),
    base64: z
      .string()
      .regex(
        /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
        "Invalid base64 file content",
      )
      .optional(),
    contentType: z.string().optional(),
    /** Write only if the document is at this version (0 = does not exist). */
    ifVersion: z.number().int().nonnegative().optional(),
  })
  .refine((v) => (v.text !== undefined) !== (v.base64 !== undefined), {
    message: "Provide exactly one of text or base64",
  });

// --- Proposals (ADR 0055) ---
export const ProposeChangeSchema = z.object({
  title: z.string().min(1).max(200),
  body: z.string().max(20_000).optional(),
  changes: z
    .array(
      z.object({
        path: z.string().min(1),
        content: z.string().optional(),
        delete: z.boolean().optional(),
      }),
    )
    .min(1)
    .max(200),
});

export const ProposalResultSchema = z.object({
  branch: z.string(),
  pullRequest: z.object({ url: z.string(), number: z.number() }).optional(),
});

export const ProposalSummarySchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  url: z.string(),
  author: z.string(),
  head: z.string(),
  base: z.string(),
  draft: z.boolean(),
  updatedAt: z.string(),
  body: z.string().optional(),
  headSha: z.string().optional(),
});
export const ProposalFileSchema = z.object({
  path: z.string(),
  status: z.string(),
  additions: z.number(),
  deletions: z.number(),
  patch: z.string().nullable(),
  previousPath: z.string().optional(),
});

export const ProposalReviewSchema = z.object({
  proposal: ProposalSummarySchema,
  files: z.array(ProposalFileSchema),
});

export const ProposalCommentSchema = z.object({
  id: z.number(),
  body: z.string(),
  author: z.object({ login: z.string() }).nullable(),
  createdAt: z.string(),
  url: z.string(),
  state: z.string().optional(),
  path: z.string().optional(),
  line: z.number().nullable().optional(),
  replyToId: z.number().optional(),
  diffHunk: z.string().optional(),
  side: z.enum(["LEFT", "RIGHT"]).optional(),
});
export const ProposalDiscussionSchema = z.object({
  state: z.string(),
  reviewDecision: z.string().nullable(),
  assignees: z.array(z.object({ login: z.string() })),
  reviewRequests: z.array(z.object({ login: z.string() })),
  reviews: z.array(ProposalCommentSchema),
  comments: z.array(ProposalCommentSchema),
  inlineComments: z.array(ProposalCommentSchema),
  inlineCommentsUnavailable: z.boolean(),
  statusCheckRollup: z.array(
    z.object({
      name: z.string(),
      status: z.string(),
      conclusion: z.string().nullable(),
      detailsUrl: z.string(),
    }),
  ),
});
export const ProposalCommentInputSchema = z.object({
  body: z.string().trim().min(1).max(60000),
  replyTo: z.number().int().positive().optional(),
});

// --- Publications (ADR 0055) ---
export const PublicationSchema = z.object({
  slug: z.string(),
  projectId: z.string(),
  path: z.string(),
  audience: z.enum(["public", "members"]),
  createdBy: z.string(),
  createdAt: z.string(),
  revokedAt: z.string().nullable(),
  /** Where the audience reads it: the public path, or the members path. */
  url: z.string(),
});

export const PublishSchema = z.object({
  path: z.string().min(1),
  audience: z.enum(["public", "members"]),
  slug: z.string().min(1).max(64).optional(),
});

export const PublicationParamsSchema = ProjectIdParamsSchema.extend({
  slug: z.string().min(1).max(64),
});

// --- Introspection (ADR 0055) ---
export const MeSchema = z.object({
  version: z.literal(1),
  identity: z.object({
    externalUserId: z.string(),
    root: z.boolean(),
    /**
     * Host-issued permissions over the organization's shared resources
     * (ADR 0172), expanded: `connections:write` also lists `connections:read`.
     */
    controlPlanePermissions: z.array(
      z.enum(["connections:read", "connections:write"]),
    ),
  }),
  projects: z.array(
    z.object({
      projectId: z.string(),
      /** The project's display name, for every member. */
      name: z.string(),
      source: z
        .object({
          remoteUrl: z.string(),
          defaultBranch: z.string(),
        })
        .nullable(),
      permissions: z.array(
        z
          .string()
          .regex(
            PROJECT_PERMISSION_PATTERN,
            "Expected a namespaced project capability",
          ),
      ),
      agents: z.array(z.string()),
      workflows: z.array(z.string()),
      apps: z.array(z.string()),
      documents: z.array(
        z.object({ path: z.string(), access: z.enum(["read", "write"]) }),
      ),
      /** The caller's roles in this project, described (ADR 0152). */
      roles: z.array(
        z.object({ name: z.string(), description: z.string().optional() }),
      ),
    }),
  ),
  features: z.object({
    publications: z.union([z.enum(["public", "members"]), z.literal(false)]),
    proposals: z.boolean(),
    /** True when a code host is configured: proposals open pull requests through the service connection. */
    proposalsOpenPullRequests: z.boolean(),
    mcp: z.boolean(),
    agentSessions: z.boolean(),
    storeUploadMaxBytes: z.number(),
  }),
  /**
   * The protocols this server speaks (ADR 0196, 0197): a client refuses a
   * server whose session or runner protocol it does not know.
   */
  agentProtocol: z.object({
    session: z.literal(1),
    runner: z.literal(RUNNER_PROTOCOL_VERSION),
  }),
});

// --- Workflow parse ---
// Pure AST parse of in-flight draft files → WorkflowGraph. Browser clients
// can't run `@catamorphic/parser` (ts-morph → node:fs) so the server does it.
export const ParseWorkflowRequestSchema = z.object({
  files: z.record(z.string(), z.string()),
  workflowName: z.string().min(1),
  preferredFilePath: z.string().optional(),
});

export const ParseWorkflowResponseSchema = WorkflowGraphSchema.nullable();

// --- Plugins ---
export const PluginSecretSchema = z.object({
  name: z.string(),
  label: z.string(),
  description: z.string(),
  required: z.boolean(),
  default: z.string().nullable(),
});

export const PluginCapabilityRequirementSchema = z.object({
  name: z.string(),
  description: z.string(),
  optional: z.boolean(),
  fulfilled: z.boolean(),
});

export const PluginManifestSchema = z.object({
  packageName: z.string(),
  version: z.string().nullable(),
  source: z.enum(["local", "npm", "git"]),
  displayName: z.string(),
  description: z.string(),
  secrets: z.array(PluginSecretSchema),
  requires: z.array(PluginCapabilityRequirementSchema),
});

export const CatalogPluginSchema = PluginManifestSchema;

export const AttachedPluginSchema = PluginManifestSchema.extend({
  attachedAt: z.string().datetime(),
  secretStatus: z.array(
    z.object({
      name: z.string(),
      hasValue: z.boolean(),
      required: z.boolean(),
    }),
  ),
});

export const AttachPluginSchema = z.object({
  packageName: z.string().min(1),
});

export const PluginPackageParamsSchema = ProjectIdParamsSchema.extend({
  packageName: z.string().min(1),
});

// --- Secrets ---
export const SecretStatusSchema = z.object({
  name: z.string(),
  hasValue: z.boolean(),
  updatedAt: z.string().datetime().nullable(),
  label: z.string().optional(),
  description: z.string().optional(),
  required: z.boolean(),
  source: z.enum(["project", "plugin"]),
});

export const UpsertSecretSchema = z.object({
  value: z.string(),
});

export const SecretNameParamsSchema = ProjectIdParamsSchema.extend({
  name: z.string().min(1),
});

// --- Code hosts (ADR 0177) ---
export const CodeHostParamsSchema = z.object({
  provider: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
});

export const CodeHostRepositorySchema = z.object({
  fullName: z.string(),
  name: z.string(),
  owner: z.string(),
  private: z.boolean(),
  defaultBranch: z.string(),
  cloneUrl: z.string(),
  description: z.string().nullable(),
  pushedAt: z.string().nullable(),
});

export const CodeHostImportSchema = z.object({
  /** Host-specific repository path, e.g. `owner/name` on GitHub. */
  fullName: z.string().regex(/^[\w.-]+\/[\w.-]+$/, "Expected owner/name"),
  name: z.string().min(1).optional(),
});

/** Publish an unlinked project to a new repository Work creates (ADR 0170). */
export const CodeHostPublishSchema = z.object({
  provider: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
  name: z.string().regex(/^[\w.-]+$/, "Expected a repository name"),
  /** Organization; the connected account when omitted. */
  organization: z
    .string()
    .regex(/^[\w.-]+$/, "Expected an organization login")
    .optional(),
  visibility: z.enum(["private", "public"]).optional(),
});

export const CodeHostPublishResultSchema = z.object({
  fullName: z.string(),
  remoteUrl: z.string(),
});

// --- Generic ---
export const ErrorSchema = z.object({
  error: z.string(),
});

/** A 403 may be project scope denial or a structured Environment denial. */
export const EnvironmentAccessErrorSchema = z.union([
  ErrorSchema,
  EnvironmentErrorSchema,
]);

export const ListSchema = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    items: z.array(item),
    total: z.number(),
  });

export const AgentCatalogSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      description: z.string().optional(),
      available: z.boolean(),
      reason: z.string().nullable(),
      environments: EnvironmentListSchema,
      /** What may leave the agent's sandbox, when declared (ADR 0182). */
      sandboxing: z.enum(SANDBOXING_LEVELS).optional(),
      /** The harness's own permission settings, as declared (ADR 0182). */
      harnessPermissions: HarnessPermissionsSchema.optional(),
    }),
  ),
  defaultAgentId: z.string().optional(),
  startingActions: z.array(
    z.object({
      label: z.string(),
      prompt: z.string(),
      agentId: z.string().optional(),
    }),
  ),
});

// --- Personal environments (ADRs 0184, 0198) ---

/** Why a body naming sign-ins is refused: they never leave their machine. */
export const PERSONAL_SIGN_INS_REFUSED =
  "Sign-ins stay on the machine they were made on (ADR 0198): sign in to the harness there, and send only files here.";

export const PutPersonalEnvironmentSchema = z
  .strictObject(
    {
      files: z
        .array(
          z.object({
            path: z
              .string()
              .min(1)
              .max(512)
              .describe("Repository-relative path, / separated"),
            content: z.string().describe("The file's bytes, base64"),
          }),
        )
        .max(50)
        .default([]),
    },
    {
      error: (issue) =>
        issue.code === "unrecognized_keys" && issue.keys.includes("logins")
          ? PERSONAL_SIGN_INS_REFUSED
          : undefined,
    },
  )
  .describe(
    "The caller's personal files for this project; replaces what the server holds",
  );

export const PersonalEnvironmentSchema = z.object({
  allowed: z
    .boolean()
    .describe(
      "Some Environment of the project gives the caller's own chats their personal files",
    ),
  files: z.array(
    z.object({
      path: z.string(),
      fingerprint: z.string(),
      bytes: z.number().int().nonnegative(),
      updatedAt: z.string(),
    }),
  ),
});

export const PersonalEnvironmentInvalidSchema = z.object({
  error: z.string(),
  code: z.literal("personal_environment_invalid"),
  issues: z.array(z.string()),
});
