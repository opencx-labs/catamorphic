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

// --- Query ---
export const RefQuerySchema = z.object({
  ref: z.string().optional(),
});

export const PaginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

// --- Templates ---
export const TemplateSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  defaultWorkflow: z.string(),
  fileCount: z.number(),
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
  workflows: z.array(
    z.object({
      name: z.string(),
      displayName: z.string().nullable(),
      description: z.string().nullable(),
      filePath: z.string(),
      parameterCount: z.number(),
    }),
  ),
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

// --- Workflows (discovered, not stored) ---
export const WorkflowSummarySchema = z.object({
  name: z.string(),
  displayName: z.string().nullable(),
  description: z.string().nullable(),
  filePath: z.string(),
  parameterCount: z.number(),
});

export const WorkflowGraphSchema = z.object({
  name: z.string(),
  displayName: z.string().nullable(),
  description: z.string().nullable(),
  filePath: z.string(),
  projectFiles: z.array(z.string()).optional(),
  allFiles: z.record(z.string(), z.string()).optional(),
  trigger: z.object({
    parameters: z.array(
      z.object({
        name: z.string(),
        type: z.string(),
        displayName: z.string().nullable(),
        description: z.string().nullable(),
        required: z.boolean(),
        defaultValue: z.string().nullable(),
      }),
    ),
  }),
  nodes: z.array(
    z.object({
      id: z.string(),
      type: z.string(),
      label: z.string(),
      description: z.string().optional(),
      functionName: z.string().optional(),
      condition: z.string().optional(),
      duration: z.string().optional(),
      parentId: z.string().optional(),
      metadata: z.record(z.string(), z.unknown()),
      sourceRange: z
        .object({
          start: z.number(),
          end: z.number(),
          startLine: z.number(),
          startColumn: z.number(),
          endLine: z.number(),
          endColumn: z.number(),
          file: z.string().optional(),
        })
        .optional(),
    }),
  ),
  edges: z.array(
    z.object({
      id: z.string(),
      source: z.string(),
      target: z.string(),
      label: z.string().optional(),
      type: z.string(),
    }),
  ),
  sourceCode: z.string(),
});

// --- Runs ---
export const RunSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  workflowName: z.string(),
  commitSha: z.string().length(40),
  isTest: z.boolean(),
  status: z.enum(["pending", "running", "completed", "failed", "cancelled"]),
  triggerData: z.unknown().nullable(),
  result: z.unknown().nullable(),
  error: z.string().nullable(),
  startedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});

export const RunStepSchema = z.object({
  id: z.string().uuid(),
  runId: z.string().uuid(),
  nodeId: z.string(),
  name: z.string(),
  status: z.enum(["pending", "running", "completed", "failed", "skipped"]),
  input: z.unknown().nullable(),
  output: z.unknown().nullable(),
  error: z.string().nullable(),
  startedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
});

export const RunDetailSchema = RunSchema.extend({
  steps: z.array(RunStepSchema),
});

export const TriggerRunSchema = z.object({
  triggerData: z.record(z.string(), z.unknown()).optional(),
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
  userId: z.string().uuid(),
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
  userId: z.string().uuid(),
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

// --- Run Report (from sandbox harness) ---
export const RunReportStepSchema = z.object({
  nodeId: z.string(),
  name: z.string(),
  status: z.enum(["completed", "failed", "skipped"]),
  input: z.unknown().optional(),
  output: z.unknown().optional(),
  error: z.string().optional(),
  startedAt: z.string(),
  completedAt: z.string(),
});

export const RunReportSchema = z.object({
  runId: z.string().uuid(),
  status: z.enum(["completed", "failed"]),
  result: z.unknown().optional(),
  error: z.string().optional(),
  steps: z.array(RunReportStepSchema),
  startedAt: z.string(),
  completedAt: z.string(),
});

// --- Playground Run ---
export const PlaygroundRunRequestSchema = z.object({
  projectId: z.string().uuid().optional(),
  files: z.record(z.string(), z.string()),
  workflowName: z.string().min(1),
  triggerData: z.record(z.string(), z.unknown()).optional(),
});

export const PlaygroundRunResponseSchema = z.object({
  runId: z.string().uuid().nullable(),
  status: z.enum(["completed", "failed"]),
  result: z.unknown().nullable(),
  error: z.string().nullable(),
  steps: z.array(RunReportStepSchema),
  startedAt: z.string(),
  completedAt: z.string(),
});

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
});

export const UpsertSecretSchema = z.object({
  value: z.string(),
});

export const SecretNameParamsSchema = ProjectIdParamsSchema.extend({
  name: z.string().min(1),
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
