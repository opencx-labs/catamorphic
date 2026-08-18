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

export const AppSummarySchema = z.object({
  name: z.string(),
  id: z.string().uuid().nullable(),
  activeVersionId: z.string().uuid().nullable(),
  publishedAt: z.string().datetime().nullable(),
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

const JsonValueSchema = z.json().meta({ id: "JsonValue" });
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
  display: TriggerKindDisplaySchema.optional(),
});

export const WorkflowTriggerBindingSchema = z.object({
  kind: z.string(),
  config: JsonOutSchema,
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
  kind: z.string(),
  config: JsonOutSchema,
  canSuspend: z.boolean(),
  inputParameters: z.array(ParameterInfoSchema),
  inputSchema: JsonOutSchema,
  outputSchema: JsonOutSchema,
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
  "parallel",
  "parallel-block",
  "scope-block",
  "durable-boundary",
  "batch",
  "pause",
  "call-workflow",
  "delay",
  "return",
]);

export const WorkflowEdgeTypeSchema = z.enum([
  "branch-false",
  "branch-true",
  "parallel",
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
  capabilities: RunCapabilitiesSchema,
  status: RunStatusSchema,
  phase: RunPhaseSchema,
  currentStepIndex: z.number().int().nonnegative().nullable(),
  activePause: RunPauseSchema.nullable(),
  batchScopes: z.array(BatchProgressSchema),
  provenance: z.object({
    commitSha: z.string().optional(),
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
  correlationKey: CorrelationKeySchema.optional(),
  onConflict: EnrollmentConflictPolicySchema.optional(),
});

export const FireTriggerSchema = z.object({
  payload: JsonValueSchema,
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

export const BranchInfoSchema = z.object({
  name: z.string(),
  commit: z.string(),
  isCurrent: z.boolean(),
  createdAt: z.number().nullable(),
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
});

export const DeployRequestSchema = z.object({
  message: z.string().min(1).optional(),
  /** Optional draft files to write to the working tree before committing. */
  files: z.record(z.string(), z.string()).optional(),
});

export const PullRequestSchema = z.object({
  /** Optional draft files to write to the working tree before merging. */
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

export const CreateBranchSchema = z.object({
  /** Optional explicit name; when omitted the server generates `work/YYYY-MM-DD_HH-mm`. */
  name: z.string().optional(),
  fromRef: z.string().optional(),
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
export const AgentEffortSchema = z.enum(["low", "medium", "high"]);

export const AgentSessionSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  externalUserId: z.string(),
  provider: z.string(),
  providerSessionId: z.string().nullable(),
  sandboxId: z.string().uuid().nullable(),
  agentId: z.string().nullable(),
  modelEffort: AgentEffortSchema.nullable(),
  title: z.string().nullable(),
  icon: z.string().nullable(),
  parentSessionId: z.string().uuid().nullable(),
  status: z.enum(["active", "closed"]),
  baseCommitSha: z.string().length(40).nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const AgentSessionIdParamsSchema = ProjectIdParamsSchema.extend({
  sessionId: z.string().uuid(),
});

export const CreateAgentSessionSchema = z.object({
  systemPrompt: z.string().optional(),
  /** Host-registry key of the agent to run this session on. */
  agentId: z.string().optional(),
  effort: AgentEffortSchema.optional(),
});

export const UpdateAgentSessionSchema = z.object({
  agentId: z.string().optional(),
  /** `null` clears the override back to the agent's default. */
  effort: AgentEffortSchema.nullable().optional(),
});

export const ForkAgentSessionSchema = z.object({
  /**
   * Fork point: the transcript is copied up to and including this
   * message. Omitted = the whole settled transcript.
   */
  messageId: z.string().uuid().optional(),
});

export const AgentMessageSchema = z.object({
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  role: z.enum(["user", "assistant", "system"]),
  content: z.string(),
  commitSha: z.string().length(40).nullable(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.string().datetime(),
});

export const OkSchema = z.object({ ok: z.literal(true) });

// --- tool permissions (ADR 0054) ---
export const ToolPermissionIdParamsSchema = AgentSessionIdParamsSchema.extend({
  permissionId: z.string().uuid(),
});
export const PendingToolPermissionSchema = z.object({
  id: z.string(),
  sessionId: z.string().optional(),
  agentLabel: z.string().optional(),
  request: z.object({
    sessionId: z.string().optional(),
    server: z.string(),
    tool: z.string(),
    description: z.string().optional(),
    input: z.record(z.string(), z.unknown()),
    annotations: z
      .object({
        readOnlyHint: z.boolean().optional(),
        destructiveHint: z.boolean().optional(),
      })
      .optional(),
  }),
  createdAt: z.string(),
  expiresAt: z.string(),
});
export const PendingToolPermissionsSchema = z.object({
  permissions: z.array(PendingToolPermissionSchema),
});
export const ToolPermissionDecisionSchema = z.discriminatedUnion("decision", [
  z.object({
    decision: z.literal("allow"),
    remember: z.literal("always").optional(),
  }),
  z.object({ decision: z.literal("deny") }),
]);

export const AgentMediaAttachmentSchema = z.object({
  kind: z.enum(["image", "document"]),
  name: z.string().min(1).max(200),
  /** MIME type, e.g. "image/png", "application/pdf". */
  mediaType: z.string().min(1).max(100),
  /** ~10MB decoded per file (base64 is 4/3 the byte size). */
  dataBase64: z.string().min(1).max(14_000_000),
});

export const AgentTextSourceSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("paste") }),
  z.object({
    type: z.literal("selection"),
    filePath: z.string().min(1).max(4096),
    startLine: z.number().int().positive().optional(),
    endLine: z.number().int().positive().optional(),
  }),
  z.object({ type: z.literal("url"), url: z.string().min(1).max(8192) }),
  z.object({ type: z.literal("path"), path: z.string().min(1).max(4096) }),
]);

/** Text context beside a message: paste, editor selection, URL, path. */
export const AgentTextAttachmentSchema = z.object({
  kind: z.literal("text"),
  name: z.string().min(1).max(200),
  /** ~2MB of text — well past any sane paste, well short of the DB row cap. */
  text: z.string().max(2_000_000),
  source: AgentTextSourceSchema,
});

export const AgentAttachmentSchema = z.union([
  AgentMediaAttachmentSchema,
  AgentTextAttachmentSchema,
]);

export const SendMessageSchema = z
  .object({
    // Empty prose is fine when attachments carry the message ("look at
    // this" with just a pill); rejected only when BOTH are empty.
    message: z.string().max(200_000),
    attachments: z.array(AgentAttachmentSchema).max(32).optional(),
  })
  .refine(
    (body) =>
      body.message.trim().length > 0 || (body.attachments?.length ?? 0) > 0,
    { message: "A message needs text or at least one attachment." },
  );

export const AgentSessionDetailSchema = AgentSessionSchema.extend({
  messages: z.array(AgentMessageSchema),
});

// --- Skills ---
export const SkillSchema = z.object({
  name: z.string(),
  /** Human-facing name (frontmatter `title`, else the humanized slug). */
  title: z.string(),
  description: z.string(),
  path: z.string(),
  source: z.enum(["project", "host"]),
});

// --- Project agent definitions (ADR 0050) ---
// Committed `agents/<slug>.json` files, parsed and validated by core's
// AgentDefinitionsService. Broken files come back as invalid entries with
// the error — never a failed request.
export const ProjectAgentDefinitionSchema = z.object({
  version: z.number(),
  name: z.string(),
  kind: z.string(),
  model: z.string().optional(),
  effort: z.enum(["low", "medium", "high"]).optional(),
  description: z.string().optional(),
  credentials: z
    .object({
      source: z.enum(["profile", "secret", "local"]),
      secret: z.string().optional(),
    })
    .optional(),
  connections: z.array(z.string()).optional(),
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
  /** Content of the sibling `agents/<slug>.md` persona file. */
  promptFile: z.string().optional(),
  invalid: z.object({ error: z.string() }).optional(),
});

// --- Roles & memberships (ADR 0055) ---
const RoleToolPolicySchema = z.object({
  default: z.enum(["allow", "ask", "deny", "auto"]).optional(),
  tools: z.record(z.string(), z.enum(["allow", "ask", "deny"])).optional(),
});

export const RoleDefinitionSchema = z.object({
  version: z.literal(1),
  name: z.string(),
  description: z.string().optional(),
  builder: z.boolean().optional(),
  agents: z
    .array(
      z.union([
        z.string(),
        z.object({
          name: z.string(),
          toolPolicies: z.record(z.string(), RoleToolPolicySchema).optional(),
        }),
      ]),
    )
    .optional(),
  workflows: z.array(z.string()).optional(),
  apps: z.array(z.string()).optional(),
  documents: z
    .array(
      z.union([
        z.string(),
        z.object({
          path: z.string(),
          access: z.enum(["read", "write"]).optional(),
        }),
      ]),
    )
    .optional(),
});

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
    base64: z.string().optional(),
    contentType: z.string().optional(),
    /** Write only if the document is at this version (0 = does not exist). */
    ifVersion: z.number().int().nonnegative().optional(),
  })
  .refine((v) => (v.text !== undefined) !== (v.base64 !== undefined), {
    message: "Provide exactly one of text or base64",
  });

// --- Playground Parse ---
// Pure AST parse of in-flight draft files → WorkflowGraph. Browser clients
// can't run `@catamorphic/parser` (ts-morph → node:fs) so the server does it.
export const PlaygroundParseRequestSchema = z.object({
  files: z.record(z.string(), z.string()),
  workflowName: z.string().min(1),
  preferredFilePath: z.string().optional(),
});

export const PlaygroundParseResponseSchema = WorkflowGraphSchema.nullable();

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

export const SecretEnvironmentQuerySchema = z.object({
  environment: z.enum(["test", "production"]).default("production"),
});

// --- GitHub ---
export const GithubStatusSchema = z.object({
  connected: z.boolean(),
  login: z.string().optional(),
});

export const GithubConnectSchema = z.object({
  /** Authorization code from the GitHub web-flow callback. */
  code: z.string().min(1),
  /** Must match the redirect_uri sent to /login/oauth/authorize, if any. */
  redirectUri: z.string().optional(),
});

export const GithubRepoSchema = z.object({
  id: z.number(),
  fullName: z.string(),
  name: z.string(),
  owner: z.string(),
  private: z.boolean(),
  defaultBranch: z.string(),
  description: z.string().nullable(),
  pushedAt: z.string().nullable(),
});

export const GithubImportSchema = z.object({
  fullName: z.string().regex(/^[\w.-]+\/[\w.-]+$/, "Expected owner/repo"),
  name: z.string().min(1).optional(),
});

// --- Generic ---
export const ErrorSchema = z.object({
  error: z.string(),
});

export const ListSchema = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    items: z.array(item),
    total: z.number(),
  });
