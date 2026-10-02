import { z } from "zod";

/**
 * Commands a person's client sends to a session (ADR 0195). Each carries a
 * client-generated `commandId`: sending the same command again returns the
 * first receipt and runs nothing.
 */

const commandId = z.string().min(8).max(200);

export const jsonValueSchema: z.ZodType<
  string | number | boolean | null | object
> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

/** Who wrote an input; {@link SessionMessageAuthor} as a schema. */
export const sessionMessageAuthorSchema = z.union([
  z.object({ kind: z.literal("user"), externalUserId: z.string() }),
  z.object({
    kind: z.literal("agent"),
    sessionId: z.string(),
    agentId: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("workflow"),
    runId: z.string(),
    workflowName: z.string(),
    displayName: z.string().optional(),
  }),
  z.object({
    kind: z.literal("watcher"),
    watcherId: z.string(),
    runId: z.string().optional(),
  }),
  z.object({ kind: z.literal("system"), code: z.string() }),
]);

export const dispatchModeSchema = z.enum([
  "queue",
  "steer",
  "interrupt",
  "message_only",
]);

const textSource = z.union([
  z.object({ type: z.literal("paste") }),
  z.object({
    type: z.literal("selection"),
    filePath: z.string(),
    startLine: z.number().int().optional(),
    endLine: z.number().int().optional(),
  }),
  z.object({ type: z.literal("url"), url: z.string() }),
  z.object({ type: z.literal("path"), path: z.string() }),
  z.object({
    type: z.literal("tab"),
    key: z.string(),
    kind: z.string(),
    title: z.string(),
    url: z.string().optional(),
    filePath: z.string().optional(),
  }),
]);

export const attachmentSchema = z.union([
  z.object({
    kind: z.enum(["image", "document"]),
    name: z.string().max(500),
    mediaType: z.string().max(200),
    dataBase64: z.string(),
  }),
  z.object({
    kind: z.literal("text"),
    name: z.string().max(500),
    text: z.string(),
    source: textSource,
  }),
]);

export const workspaceRequestSchema = z.object({
  ref: z.string().min(1).max(500),
  update: z.enum(["rebase", "reset"]).optional(),
});

export const runtimeRequestResponseSchema = z.union([
  z.object({
    kind: z.literal("approval"),
    decision: z.enum(["approved", "denied"]),
    remember: z.literal("always").optional(),
  }),
  z.object({
    kind: z.literal("question"),
    answers: z.array(z.string().max(200_000)).min(1),
  }),
  z.object({
    kind: z.literal("elicitation"),
    action: z.enum(["accept", "decline", "cancel"]),
    content: jsonValueSchema.optional(),
  }),
]);

export const sessionCommandSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("send"),
    commandId,
    text: z.string().min(1).max(1_000_000),
    attachments: z.array(attachmentSchema).max(50).optional(),
    /** Default: steer a running subsession, queue otherwise. */
    dispatch: z.enum(["queue", "steer", "interrupt"]).optional(),
    /** Move the chat's workspace to a ref before this turn (ADR 0178). */
    workspace: workspaceRequestSchema.optional(),
  }),
  z.object({
    type: z.literal("interrupt"),
    commandId,
    /** Interrupt only this turn; a turn already settled is not an error. */
    turnId: z.string().optional(),
  }),
  z.object({
    type: z.literal("retry"),
    commandId,
    turnId: z.string(),
  }),
  z.object({
    type: z.literal("edit_queued"),
    commandId,
    turnId: z.string(),
    text: z.string().min(1).max(1_000_000).optional(),
    held: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("cancel_queued"),
    commandId,
    turnId: z.string(),
  }),
  z.object({
    /** Run a queued turn now: it becomes the next turn and stops the active one. */
    type: z.literal("send_now"),
    commandId,
    turnId: z.string(),
  }),
  z.object({
    type: z.literal("respond"),
    commandId,
    requestId: z.string(),
    response: runtimeRequestResponseSchema,
  }),
  z.object({
    /** Undo this turn and every later one: files and conversation. */
    type: z.literal("rollback"),
    commandId,
    turnId: z.string(),
  }),
]);

export type SessionCommand = z.infer<typeof sessionCommandSchema>;
export type SessionCommandType = SessionCommand["type"];
