import { z } from "zod";

export const privateSnapshotSchema = z.object({
  key: z.string(),
  address: z.string(),
  version: z.number().int().nonnegative(),
  value: z.json(),
});
export const versionSchema = z.object({
  version: z.number().int().nonnegative(),
});
export const processSnapshotSchema = z.object({
  key: z.string(),
  lifetime: z.enum(["view", "application"]),
  processId: z.string(),
  command: z.string(),
  name: z.string().optional(),
  status: z.enum(["running", "exited"]),
  exitCode: z.number().nullable(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  enabled: z.boolean().optional(),
  error: z.string().optional(),
});
export const processOutputSchema = z.object({
  chunk: z.string(),
  cursor: z.number(),
  nextCursor: z.number(),
  more: z.boolean(),
  outputBytes: z.number(),
  status: z.enum(["running", "exited"]),
  exitCode: z.number().nullable(),
});
export const runSnapshotSchema = z.object({
  runId: z.string(),
  status: z.enum([
    "pending",
    "running",
    "waiting",
    "paused",
    "canceling",
    "completed",
    "failed",
    "canceled",
  ]),
  output: z.unknown(),
  error: z.string().nullable(),
});
