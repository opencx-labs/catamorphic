import { z } from "zod";

export const WorkflowSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  code: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const CreateWorkflowSchema = z.object({
  name: z.string().min(1),
  code: z.string(),
});

export const UpdateWorkflowSchema = z.object({
  name: z.string().min(1).optional(),
  code: z.string().optional(),
});

export const WorkflowIdParamsSchema = z.object({
  id: z.string().uuid(),
});

export const RunIdParamsSchema = z.object({
  runId: z.string().uuid(),
});

export const WorkflowRunSchema = z.object({
  id: z.string().uuid(),
  workflowId: z.string().uuid(),
  status: z.string(),
  triggerData: z.record(z.string(), z.string()).nullable(),
  result: z.record(z.string(), z.string()).nullable(),
  error: z.string().nullable(),
  startedAt: z.string(),
  completedAt: z.string().nullable(),
});

export const WorkflowRunStepSchema = z.object({
  id: z.string().uuid(),
  runId: z.string().uuid(),
  nodeId: z.string(),
  name: z.string(),
  status: z.string(),
  input: z.record(z.string(), z.string()).nullable(),
  output: z.record(z.string(), z.string()).nullable(),
  error: z.string().nullable(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
});

export const RunStatusSchema = WorkflowRunSchema.extend({
  steps: z.array(WorkflowRunStepSchema),
});

export const CreateRunSchema = z.object({
  triggerData: z.record(z.string(), z.string()).optional(),
});

export const ParseResultSchema = z.object({
  name: z.string(),
  displayName: z.string().nullable(),
  description: z.string().nullable(),
  nodes: z.array(
    z.object({
      id: z.string(),
      type: z.string(),
      label: z.string(),
      description: z.string().optional(),
      functionName: z.string().optional(),
      condition: z.string().optional(),
      duration: z.string().optional(),
      metadata: z.record(z.string(), z.string()),
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
});

export const ErrorSchema = z.object({
  error: z.string(),
});

export const ListSchema = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    items: z.array(item),
    total: z.number(),
  });
