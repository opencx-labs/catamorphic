import { z } from "zod";

/**
 * Commands a person's client sends to a session (ADR 0197). Each carries a
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

const sessionUserSchema = z.object({
  kind: z.literal("user"),
  externalUserId: z.string(),
});

/** {@link InboundSender} as a schema. */
export const inboundSenderSchema = z.union([
  z.object({
    kind: z.literal("agent"),
    sessionId: z.string(),
    agentId: z.string().nullable(),
    projectId: z.string().optional(),
  }),
  z.object({ kind: z.literal("assistant"), externalUserId: z.string() }),
  z.object({
    kind: z.literal("workflow"),
    runId: z.string(),
    workflowName: z.string(),
    displayName: z.string().optional(),
    enablementId: z.string().optional(),
    watcher: z.object({ id: z.string(), sessionId: z.string() }).optional(),
    scheduledFor: z.string().optional(),
    firedAt: z.string().optional(),
  }),
]);

/** Who wrote an input; {@link SessionMessageAuthor} as a schema. */
export const sessionMessageAuthorSchema = z.union([
  sessionUserSchema,
  inboundSenderSchema,
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

export const inputSourceSchema = z.union([
  z.object({
    kind: z.literal("session"),
    sessionId: z.string(),
    projectId: z.string().optional(),
  }),
  z.object({
    kind: z.literal("workflow_run"),
    runId: z.string(),
    workflowName: z.string(),
  }),
  z.object({ kind: z.literal("surface"), key: z.string() }),
]);

export const taskNotificationStatusSchema = z.enum([
  "completed",
  "failed",
  "update",
  "needs_input",
  "stopped",
]);

/** {@link AgentQuestion} as a schema. */
export const agentQuestionSchema = z.object({
  question: z.string(),
  header: z.string(),
  multiSelect: z.boolean(),
  options: z.array(z.object({ label: z.string(), description: z.string() })),
});

/** {@link QuestionAnswer} as a schema. */
export const questionAnswerSchema = z.object({
  requestId: z.string(),
  questions: z.array(agentQuestionSchema),
  answers: z.array(z.string()),
  attachments: z.array(z.array(attachmentSchema)).optional(),
});

/** {@link SettledAlert} as a schema. */
export const settledAlertSchema = z.object({
  title: z.string().optional(),
  body: z.string().optional(),
});

/** {@link SessionInput} as a schema: what a delivery carries between hosts. */
export const sessionInputSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("user_message"),
    author: sessionUserSchema,
    text: z.string(),
    attachments: z.array(attachmentSchema),
    answer: questionAnswerSchema.optional(),
  }),
  z.object({
    kind: z.literal("inbound_message"),
    from: inboundSenderSchema,
    text: z.string(),
    attachments: z.array(attachmentSchema),
    alert: settledAlertSchema.optional(),
  }),
  z.object({
    kind: z.literal("task_notification"),
    task: z.object({
      type: z.string().min(1).max(100),
      id: z.string().min(1).max(500),
      title: z.string().max(2_000),
      status: taskNotificationStatusSchema,
    }),
    summary: z.string().min(1).max(2_000),
    detail: z.string(),
    source: inputSourceSchema.nullable(),
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
    reason: z.string().max(2_000).optional(),
  }),
  z.object({
    kind: z.literal("question"),
    answers: z.array(z.string().max(200_000)).min(1),
    /** Each answer's pills; as many in all as a message may carry. */
    attachments: z
      .array(z.array(attachmentSchema))
      .refine((each) => each.flat().length <= 50, {
        message: "Answers can carry at most 50 attachments",
      })
      .optional(),
  }),
  z.object({
    kind: z.literal("elicitation"),
    action: z.enum(["accept", "decline", "cancel"]),
    content: jsonValueSchema.optional(),
  }),
]);

export const sessionCommandSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("send"),
      commandId,
      /** May be empty when attachments carry the message. */
      text: z.string().max(1_000_000),
      attachments: z.array(attachmentSchema).max(50).optional(),
      /**
       * Default: steer, so a turn that works reads it at its next step
       * (ADR 0240); with nothing running it starts a turn. `queue` waits
       * for the turn to end; `interrupt` stops it and runs this next.
       */
      dispatch: z.enum(["queue", "steer", "interrupt"]).optional(),
      /** Move the chat's workspace to a ref before this turn (ADR 0178). */
      workspace: workspaceRequestSchema.optional(),
    })
    .refine(
      (send) => send.text.trim() !== "" || (send.attachments?.length ?? 0) > 0,
      {
        message: "A message needs text or an attachment",
      },
    ),
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
    /**
     * Have the agent read a message steered into its turn now, not at its
     * next step: the step stops and the turn goes on with it (ADR 0240).
     */
    type: z.literal("steer_now"),
    commandId,
    itemId: z.string(),
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
