import { z } from "zod";

// --- Params ---
export const ProjectIdParamsSchema = z.object({
  projectId: z.string().uuid(),
});

export const WorkflowNameParamsSchema = ProjectIdParamsSchema.extend({
  name: z.string().min(1),
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
          start: z.object({ line: z.number(), column: z.number() }),
          end: z.object({ line: z.number(), column: z.number() }),
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
  status: z.enum(["pending", "running", "completed", "failed", "cancelled"]),
  triggerData: z.record(z.string(), z.unknown()).nullable(),
  result: z.record(z.string(), z.unknown()).nullable(),
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
  input: z.record(z.string(), z.unknown()).nullable(),
  output: z.record(z.string(), z.unknown()).nullable(),
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

// --- Generic ---
export const ErrorSchema = z.object({
  error: z.string(),
});

export const ListSchema = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    items: z.array(item),
    total: z.number(),
  });
