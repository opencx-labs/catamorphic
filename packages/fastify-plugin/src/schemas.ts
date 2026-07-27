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
    code: z.string(),
    css: z.string(),
    allowedWorkflows: z.array(z.string()),
  }),
]);

export const BuildAppSchema = z.object({
  kind: z.enum(["preview", "published"]),
  commitSha: z
    .string()
    .regex(/^[0-9a-f]{7,64}$/i)
    .optional(),
});

// --- Templates ---
export const TemplateSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  defaultWorkflow: z.string(),
  fileCount: z.number(),
});

// --- Workflows (discovered, not stored) ---
export const WorkflowCapabilitiesSchema = z.object({
  persistedContinuations: z.boolean(),
  batchProcessing: z.boolean(),
  cancellation: z.boolean(),
});

export const WorkflowSummarySchema = z.object({
  name: z.string(),
  capabilities: WorkflowCapabilitiesSchema,
  displayName: z.string().nullable(),
  description: z.string().nullable(),
  filePath: z.string(),
  parameterCount: z.number(),
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

export const CreateProjectSchema = z.object({
  name: z.string().min(1),
  templateId: z.string().optional(),
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
  "trigger",
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

// This schema mirrors `@catamorphic/parser`'s `WorkflowGraph` exactly so that
// the OpenAPI-derived response types align with the parser's in-memory types
// and `layoutGraph(...)` can consume responses without any adapter.
export const ParameterInfoSchema = z.object({
  name: z.string(),
  type: z.string(),
  optional: z.boolean(),
  displayName: z.string().optional(),
  description: z.string().optional(),
  defaultValue: z.string().optional(),
});

export const SourceRangeSchema = z.object({
  start: z.number(),
  end: z.number(),
  startLine: z.number(),
  startColumn: z.number(),
  endLine: z.number(),
  endColumn: z.number(),
  file: z.string().optional(),
});

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
  trigger: z.object({ parameters: z.array(ParameterInfoSchema) }),
  nodes: z.array(WorkflowNodeSchema),
  edges: z.array(WorkflowEdgeSchema),
  sourceCode: z.string(),
});

export const WorkflowDetailSchema = WorkflowGraphSchema.extend({
  projectFiles: z.array(z.string()),
  allFiles: z.record(z.string(), z.string()),
});

// --- Runs ---
export const RunModeSchema = z.enum(["test", "production"]);

const JsonValueSchema = z.json().meta({ id: "JsonValue" });

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
    mutableSource: z.literal(true).optional(),
  }),
  artifact: z.object({ deploymentArtifactId: z.string().uuid() }).optional(),
  mode: RunModeSchema,
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

export const TriggerTestRunSchema = z.object({
  input: JsonValueSchema.optional(),
  files: z.record(z.string(), z.string()).optional(),
});

export const RunsQuerySchema = PaginationQuerySchema.extend({
  mode: RunModeSchema.optional(),
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
export const AgentSessionSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  externalUserId: z.string(),
  provider: z.string(),
  providerSessionId: z.string().nullable(),
  sandboxId: z.string().uuid().nullable(),
  title: z.string().nullable(),
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

export const SendMessageSchema = z.object({
  message: z.string().min(1),
});

export const AgentSessionDetailSchema = AgentSessionSchema.extend({
  messages: z.array(AgentMessageSchema),
});

// --- Skills ---
export const SkillSchema = z.object({
  name: z.string(),
  description: z.string(),
  path: z.string(),
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

export const PluginManifestSchema = z.object({
  packageName: z.string(),
  version: z.string().nullable(),
  source: z.enum(["local", "npm", "git"]),
  displayName: z.string(),
  description: z.string(),
  secrets: z.array(PluginSecretSchema),
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
  environment: RunModeSchema.default("production"),
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
