import { createHash, randomUUID } from "node:crypto";
import {
  runtimeRequestResponseSchema,
  type SessionMessageAuthor,
  SessionMetadataError,
} from "@catamorphic/agent-protocol";
import { type DB, type Json, jsonbText } from "@catamorphic/db";
import { getTracer, withSpan } from "@catamorphic/otel";
import { type Kysely, sql } from "kysely";
import { z } from "zod";
import { type Identity, TokenScopeRequiredError } from "../identity.js";
import {
  AgentNotConfiguredError,
  AgentSessionAuthorityRequiredError,
  AgentSessionClosedError,
  AgentSessionNotFoundError,
  type AgentSessionSource,
  type AgentSessionsService,
  protocolJson,
} from "./agent-sessions-service.js";
import { AccessDeniedError } from "./artifact-scope.js";
import {
  type ChatAudience,
  ChatAudienceSchema,
  ChatKeySchema,
  keyedChatOwnerId,
} from "./chat-delivery.js";
import { AuthenticationRequiredError } from "./connections-service.js";
import {
  EnvironmentAccessDeniedError,
  EnvironmentBindingUnavailableError,
  EnvironmentIncompatibleError,
  EnvironmentNotFoundError,
  NoCompatibleEnvironmentError,
} from "./execution-environments-service.js";
import { ProjectNotFoundError } from "./projects-service.js";
import {
  SESSION_STATES,
  type SessionState,
  SessionStateSchema,
  sessionStateOutputSchema,
} from "./session-state.js";
import { SessionWorkspaceRequestSchema } from "./session-workspaces.js";
import { SessionCommandRejectedError } from "./sessions/session-log.js";
import { SessionInputNotFoundError } from "./sessions/session-results.js";
import { SUBSESSION_WORKSPACES } from "./sessions/subsession-tools.js";
import type { WatchersService } from "./watchers-service.js";
import { EnvironmentCapacityError } from "./worker-capacity.js";

/**
 * The session operations (ADR 0346): one registry every surface projects.
 * REST routes, the MCP endpoints, in-product agent tools and workflows'
 * `host["catamorphic.sessions"]` all call {@link SessionOperationsService}
 * with a name from here, so a chat is started, sent to, waited on and
 * answered the same way everywhere.
 */

/** What a tool-execution failure says, on every surface. */
export const SESSION_OPERATION_ERROR_CODES = [
  "not_found",
  "not_authorized",
  "invalid_input",
  "agent_unknown",
  "environment_unavailable",
  "environment_full",
  "authentication_required",
  "session_closed",
  "session_elsewhere",
  "request_not_pending",
  "idempotency_conflict",
  "internal",
] as const;
export type SessionOperationErrorCode =
  (typeof SESSION_OPERATION_ERROR_CODES)[number];

/** A session operation that refused, with a code a caller can act on. */
export class SessionOperationError extends Error {
  constructor(
    readonly code: SessionOperationErrorCode,
    message: string,
    readonly options: { retryable?: boolean; sessionId?: string } = {},
  ) {
    super(message);
    this.name = "SessionOperationError";
  }
  get retryable(): boolean {
    return this.options.retryable ?? false;
  }
  get sessionId(): string | undefined {
    return this.options.sessionId;
  }
  /** The body every surface answers with. */
  toJSON(): {
    error: {
      code: SessionOperationErrorCode;
      message: string;
      retryable: boolean;
      sessionId?: string;
    };
  } {
    return {
      error: {
        code: this.code,
        message: this.message,
        retryable: this.retryable,
        ...(this.sessionId ? { sessionId: this.sessionId } : {}),
      },
    };
  }
}

export class SessionKeyNotFoundError extends Error {
  constructor(readonly key: string) {
    super(`No open chat has the key ${key}`);
    this.name = "SessionKeyNotFoundError";
  }
}

/** Any failure of an operation as the error its caller reads. */
export function sessionOperationError(
  error: unknown,
  sessionId?: string,
): SessionOperationError {
  if (error instanceof SessionOperationError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const refuse = (
    code: SessionOperationErrorCode,
    text = message,
    retryable = false,
  ) =>
    new SessionOperationError(code, text, {
      retryable,
      ...(sessionId ? { sessionId } : {}),
    });
  if (error instanceof SessionMetadataError) return refuse("invalid_input");
  if (error instanceof TokenScopeRequiredError) return refuse("not_authorized");
  if (error instanceof z.ZodError)
    return refuse(
      "invalid_input",
      error.issues
        .map((issue) =>
          issue.path.length
            ? `${issue.path.join(".")}: ${issue.message}`
            : issue.message,
        )
        .join("; "),
    );
  if (
    error instanceof AgentSessionNotFoundError ||
    error instanceof ProjectNotFoundError ||
    error instanceof SessionKeyNotFoundError ||
    error instanceof SessionInputNotFoundError
  )
    return refuse("not_found");
  if (
    error instanceof AccessDeniedError ||
    error instanceof EnvironmentAccessDeniedError
  )
    return refuse(
      "not_authorized",
      message || "Not authorized for that chat or agent.",
    );
  if (error instanceof AgentNotConfiguredError) return refuse("agent_unknown");
  if (error instanceof EnvironmentCapacityError)
    return refuse("environment_full", message, true);
  if (
    error instanceof EnvironmentBindingUnavailableError ||
    error instanceof EnvironmentNotFoundError ||
    error instanceof NoCompatibleEnvironmentError ||
    error instanceof EnvironmentIncompatibleError
  )
    return refuse("environment_unavailable", message, true);
  if (error instanceof AuthenticationRequiredError)
    return refuse("authentication_required");
  if (error instanceof AgentSessionClosedError) return refuse("session_closed");
  if (error instanceof AgentSessionAuthorityRequiredError)
    return refuse("session_elsewhere");
  if (error instanceof SessionCommandRejectedError)
    return refuse(
      error.code === "not_found" ? "not_found" : "request_not_pending",
    );
  return refuse("internal", message, true);
}

/**
 * A chat by `sessionId`, or by the project's `key` for it (ADR 0173):
 * the caller's own keyed chat, the project chat with `audience: "project"`
 * (the default for a project automation), or a member's.
 */
const target = {
  sessionId: z
    .string()
    .uuid()
    .optional()
    .describe("The chat's id, as session_start and session_list return it"),
  key: ChatKeySchema.optional().describe(
    "Instead of sessionId: the project's key for a keyed chat",
  ),
  audience: ChatAudienceSchema.optional().describe(
    'With key: "project" for the project chat, or { member } for theirs',
  ),
  project: z
    .string()
    .uuid()
    .optional()
    .describe(
      "Project id; only on a server-wide connection, and only with key",
    ),
};
const idempotencyKey = z
  .string()
  .min(1)
  .max(300)
  .describe(
    "Any unique string you choose for this call; repeat it when you retry and the first result comes back",
  );
const mutation = { ...target, idempotencyKey };
const revision = {
  expectedStateRevision: z.number().int().nonnegative().optional(),
};
export function namesOneChat(value: object, context: z.RefinementCtx): void {
  const given = (field: string) =>
    field in value && Reflect.get(value, field) !== undefined;
  if (Number(given("sessionId")) + Number(given("key")) !== 1)
    context.addIssue({
      code: "custom",
      message: "Name the chat with exactly one of sessionId or key",
    });
  if (given("audience") && !given("key"))
    context.addIssue({
      code: "custom",
      message: "audience applies only to a chat named by key",
    });
}
function chat<Shape extends typeof target>(shape: Shape) {
  return z.strictObject(shape).superRefine(namesOneChat);
}

const effort = z.enum(["low", "medium", "high", "xhigh", "max"]);
const READ_SECTIONS = [
  "transcript",
  "results",
  "usage",
  "attempts",
  "metadata",
] as const;

/** A wait holds a call at most this long: under the 60 seconds clients allow. */
export const SESSION_WAIT_MAX_SECONDS = 50;
export const SESSION_WAIT_DEFAULT_SECONDS = 25;

const Loose = z.record(z.string(), z.unknown());
const Sent = z.object({
  messageId: z.string(),
  turnId: z.string().nullable(),
  /** False when an earlier call with the same idempotency key delivered it. */
  created: z.boolean(),
});

const READ_ONLY = { readOnlyHint: true, idempotentHint: true } as const;

/** What a tool call does, as MCP clients read it. */
export interface SessionOperationAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
}

export interface SessionOperationDefinition {
  /** The tool's name, snake_case `session_<verb>`. */
  name: string;
  title: string;
  /** When to use it, what comes back, then the next step. */
  description: string;
  input: z.ZodType;
  /** The whole answer, which every answer is checked against. */
  output: z.ZodType;
  /**
   * The answer as a tool declares it to clients: compact JSON Schema, the
   * fields a caller acts on (see `SESSION_STATE_OUTPUT_SCHEMA`).
   */
  outputSchema: Record<string, unknown>;
  annotations: SessionOperationAnnotations;
  /** The OAuth scope a token needs to call it. */
  scope: "work:read" | "sessions:run";
}

function define<
  const Name extends string,
  Input extends z.ZodType,
  Output extends z.ZodType,
>(
  name: Name,
  definition: Omit<
    SessionOperationDefinition,
    "name" | "input" | "output" | "outputSchema"
  > & {
    input: Input;
    output: Output;
    outputSchema?: Record<string, unknown>;
  },
): Omit<SessionOperationDefinition, "name" | "input" | "output"> & {
  name: Name;
  input: Input;
  output: Output;
} {
  return { name, outputSchema: { type: "object" }, ...definition };
}

const SENT_OUTPUT = {
  sent: {
    type: "object",
    description: "The message delivered: messageId, turnId, created",
  },
};

/**
 * Every session operation. Adding one here adds it to REST's operation
 * route, both MCP endpoints, in-product tools and workflows at once.
 */
export const SESSION_OPERATIONS = {
  session_start: define("session_start", {
    title: "Start a chat",
    description:
      "Use this to give a coding agent on the server a task. It starts a new chat with one of the project's agents and delivers your message as its first turn. It returns at once, before the agent has done anything: the chat's sessionId, state working and a cursor. Next: keep doing your own work, then call session_wait with that sessionId and cursor. With key, the project's open chat for that key is reused instead of starting another.",
    input: z.strictObject({
      project: target.project.describe(
        "Project id (project_list lists yours); needed only on a server-wide connection",
      ),
      agent: z
        .string()
        .min(1)
        .max(300)
        .optional()
        .describe(
          "The agent's slug or id. Omitted: the project's default agent",
        ),
      message: z.string().min(1).max(1_000_000),
      environment: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe("The Environment to run in; omitted, the agent's own choice"),
      ref: SessionWorkspaceRequestSchema.optional().describe(
        "Start the workspace at a branch, tag, commit or refs/pull/<n>/head of the project's remote",
      ),
      model: z.string().min(1).max(200).optional(),
      effort: effort.optional(),
      title: z.string().max(500).optional(),
      key: target.key.describe(
        "A name the project keeps for this chat (pr-42): the open chat for it is reused, else one starts",
      ),
      audience: target.audience,
      idempotencyKey,
    }),
    output: SessionStateSchema.extend({ sent: Sent.optional() }),
    outputSchema: sessionStateOutputSchema(SENT_OUTPUT),
    annotations: {},
    scope: "sessions:run",
  }),
  session_send: define("session_send", {
    title: "Send a message to a chat",
    description:
      "Use this to tell a chat's agent something more: a follow-up task, a correction, or new information. mode queue (default) runs it after the current turn, steer adds it to the turn in progress, interrupt stops that turn and runs this next, message_only records it without waking the agent. It returns the chat's state at once, without waiting for the agent. Next: session_wait with the returned cursor.",
    input: chat({
      ...mutation,
      message: z.string().min(1).max(1_000_000),
      mode: z.enum(["queue", "steer", "interrupt", "message_only"]).optional(),
      attention: z
        .enum(["required", "none"])
        .optional()
        .describe("required: flag this message for the chat's person"),
      ref: SessionWorkspaceRequestSchema.optional().describe(
        "Move the chat's workspace to this ref before the turn",
      ),
    }),
    output: SessionStateSchema.extend({ sent: Sent.optional() }),
    outputSchema: sessionStateOutputSchema(SENT_OUTPUT),
    annotations: {},
    scope: "sessions:run",
  }),
  session_wait: define("session_wait", {
    title: "Wait for a chat",
    description:
      "Use this to find out when a chat you started needs you. It holds until one of the chats is idle (its turn finished), failed, needs_input (its agent asked something) or closed, and returns that chat's state. Pass the cursor the last call for these chats returned, so you hear only what happened after it. It returns within timeoutSeconds (at most 50): changed false means nothing happened yet, so call it again with the returned cursor. Next: on needs_input, session_answer; on idle, the reply, results and pullRequests are in this answer; on failed, read error.",
    input: z.strictObject({
      sessionIds: z.array(z.string().uuid()).min(1).max(20),
      cursor: z
        .string()
        .max(2_000)
        .optional()
        .describe("The cursor a call for these chats returned"),
      timeoutSeconds: z
        .number()
        .int()
        .min(1)
        .max(SESSION_WAIT_MAX_SECONDS)
        .optional()
        .describe(`Default ${SESSION_WAIT_DEFAULT_SECONDS}`),
      onInput: z
        .enum(["ask", "return"])
        .optional()
        .describe(
          "ask: a client that can ask its person is asked the agent's question itself; return (default): the question comes back in requests",
        ),
    }),
    output: SessionStateSchema.extend({
      /** The other watched chats, when several were named. */
      others: z
        .array(
          z.object({
            sessionId: z.string(),
            state: z.enum(SESSION_STATES),
            cursor: z.string(),
          }),
        )
        .optional(),
    }),
    outputSchema: sessionStateOutputSchema({
      changed: {
        type: "boolean",
        description: "false: nothing happened yet; wait again with this cursor",
      },
      others: {
        type: "array",
        items: { type: "object" },
        description: "The other watched chats: sessionId, state, cursor",
      },
    }),
    annotations: READ_ONLY,
    scope: "work:read",
  }),
  session_read: define("session_read", {
    title: "Read a chat",
    description:
      "Use this to look at a chat now, without waiting: where it stands (state), what its agent asks (requests), its last reply, its typed results and the pull requests it opened. include adds more to the answer: transcript (the newest limit messages, oldest first, ending at through when given), results (every result, filtered by name, turnId, afterInput, family, order), usage (model tokens and cost), attempts (of the turn named by turnId, each with the phases of its preparation and how long they took), or metadata. Next: session_wait if it is still working.",
    input: chat({
      ...target,
      include: z.array(z.enum(READ_SECTIONS)).max(5).optional(),
      limit: z.number().int().min(1).max(100).optional(),
      through: z
        .string()
        .uuid()
        .optional()
        .describe("End the transcript at this message id"),
      turnId: z.string().uuid().optional(),
      name: z.string().min(1).max(64).optional(),
      family: z
        .boolean()
        .optional()
        .describe("Add its subsessions' results or usage"),
      afterInput: z.string().uuid().optional(),
      order: z.enum(["newest", "oldest"]).optional(),
    }),
    output: SessionStateSchema,
    outputSchema: sessionStateOutputSchema({
      transcript: {
        type: "array",
        items: { type: "object" },
        description: "With include transcript: id, role, content, createdAt",
      },
      usage: { type: "object", description: "With include usage" },
      attempts: {
        type: "array",
        items: { type: "object" },
        description:
          "With include attempts: id, status, error, diagnostics, and phases (how long each part of its preparation took: phase, startedAt, endedAt)",
      },
      metadata: { type: "object", description: "With include metadata" },
    }),
    annotations: READ_ONLY,
    scope: "work:read",
  }),
  session_answer: define("session_answer", {
    title: "Answer a chat's request",
    description:
      'Use this when a chat is in state needs_input: it answers one of its requests, by requestId, so the agent goes on. For a question: response { kind: "question", answers: [one string per question] }. An approval is your person\'s to decide, not yours: answer one only when they told you to, with { kind: "approval", decision: "approved" | "denied" }; without that permission it is refused and waits for them in Work. It returns the chat\'s state. Next: session_wait with the returned cursor.',
    input: chat({
      ...mutation,
      requestId: z.string().min(1).max(200),
      response: runtimeRequestResponseSchema,
    }),
    output: SessionStateSchema,
    outputSchema: sessionStateOutputSchema(),
    annotations: {},
    scope: "sessions:run",
  }),
  session_interrupt: define("session_interrupt", {
    title: "Stop a chat's work",
    description:
      "Use this to stop what a chat's agent is doing now, when the work went wrong or is no longer wanted. It stops the turn in progress (turnId: only that turn) and keeps what was done so far; the chat stays open. It returns the chat's state and interrupted: whether a turn was stopped. Next: session_send to redirect it, or session_close when you are done with it.",
    input: chat({ ...mutation, turnId: z.string().uuid().optional() }),
    output: SessionStateSchema.extend({
      interrupted: z.boolean(),
      forwarded: z.boolean().optional(),
    }),
    outputSchema: sessionStateOutputSchema({
      interrupted: {
        type: "boolean",
        description: "Whether a working turn was stopped",
      },
    }),
    annotations: { destructiveHint: true, idempotentHint: true },
    scope: "sessions:run",
  }),
  session_close: define("session_close", {
    title: "Close a chat",
    description:
      "Use this when a task is finished and you will send the chat nothing more. It ends the chat: its work stops, its workspace on the server is released and its key is freed; the transcript and results stay readable with session_read. It cannot be undone. It returns closed: whether this call closed it.",
    input: chat(mutation),
    output: SessionStateSchema.partial().extend({
      sessionId: z.string().nullable(),
      closed: z.boolean(),
      forwarded: z.boolean().optional(),
    }),
    outputSchema: sessionStateOutputSchema(
      {
        sessionId: { type: ["string", "null"] },
        closed: {
          type: "boolean",
          description: "Whether this call closed the chat",
        },
      },
      ["closed"],
    ),
    annotations: { destructiveHint: true, idempotentHint: true },
    scope: "sessions:run",
  }),
  session_list: define("session_list", {
    title: "List chats",
    description:
      "Use this to find chats you did not just start: your chats in a project, newest first, each with its sessionId, title and state. state keeps one state (needs_input: the chats waiting on an answer); key finds the open chat for a key. It returns sessions, total and nextCursor (pass it as cursor for the next page). Next: session_read for one chat's detail, or session_wait to follow it.",
    input: z.strictObject({
      project: target.project.describe(
        "Project id (project_list lists yours); needed only on a server-wide connection",
      ),
      state: z.enum(SESSION_STATES).optional(),
      key: target.key,
      audience: target.audience,
      limit: z.number().int().min(1).max(100).optional(),
      cursor: z.string().max(40).optional(),
    }),
    output: z.object({
      sessions: z.array(SessionStateSchema),
      total: z.number().int(),
      nextCursor: z.string().nullable(),
    }),
    outputSchema: {
      type: "object",
      properties: {
        sessions: {
          type: "array",
          items: { type: "object" },
          description: "Each chat as session_read answers, without results",
        },
        total: { type: "integer" },
        nextCursor: {
          type: ["string", "null"],
          description: "Pass as cursor for the next page; null at the end",
        },
      },
      required: ["sessions", "total", "nextCursor"],
    },
    annotations: READ_ONLY,
    scope: "work:read",
  }),
  session_fork: define("session_fork", {
    title: "Fork a chat",
    description:
      "Start a new chat from a copy of this one's conversation, up to messageId when given.",
    input: chat({ ...mutation, messageId: z.string().uuid().optional() }),
    output: Loose,
    annotations: {},
    scope: "sessions:run",
  }),
  session_spawn: define("session_spawn", {
    title: "Start a subsession",
    description:
      "Start a subsession of a chat through its agent's grants (a copy of its agent unless agentId names another). Its result arrives in the parent chat.",
    input: chat({
      ...mutation,
      task: z.string().min(1),
      /** Omitted: a copy of the chat's own agent (ADR 0271). */
      agentId: z.string().optional(),
      model: z.string().min(1).optional(),
      effort: effort.optional(),
      readOnly: z.boolean().optional(),
      delegate: z.boolean().optional(),
      /** Its parent's workspace (default) or its own (ADR 0322). */
      workspace: z.enum(SUBSESSION_WORKSPACES).optional(),
      title: z.string().max(500).optional(),
      contextMode: z.enum(["fresh", "inherit"]).optional(),
    }),
    output: Loose,
    annotations: {},
    scope: "sessions:run",
  }),
  session_archive: define("session_archive", {
    title: "Archive a chat",
    description:
      "Hide a chat for you and stop its work; a delivery brings it back.",
    input: chat({ ...mutation, confirmStop: z.boolean().optional() }),
    output: Loose,
    annotations: { destructiveHint: true, idempotentHint: true },
    scope: "sessions:run",
  }),
  session_unarchive: define("session_unarchive", {
    title: "Restore an archived chat",
    description: "Bring an archived chat back into view.",
    input: chat(mutation),
    output: Loose,
    annotations: { idempotentHint: true },
    scope: "sessions:run",
  }),
  /**
   * End a running turn's attempt without asking its harness and run the
   * same turn again on a new attempt (ADR 0333), with the authority that
   * interrupts the chat. Refuses a turn that is not running.
   */
  session_restart: define("session_restart", {
    title: "Restart a stalled turn",
    description:
      "End a running turn's attempt without asking its harness and run the same turn again on a new attempt. Name the attempt to end; one that moved on is left alone and the answer says why.",
    input: chat({
      ...mutation,
      turnId: z.string().uuid(),
      /** The attempt to end: never whichever one runs by then. */
      attemptId: z.string().uuid(),
      reason: z.string().min(1).max(500),
      /** Only while it is stalled, as it was when the stall was reported. */
      onlyIfStalled: z.boolean().optional(),
    }),
    output: Loose,
    annotations: { destructiveHint: true },
    scope: "sessions:run",
  }),
  session_complete: define("session_complete", {
    title: "Mark a chat's work finished",
    description:
      "Record that the chat's work is finished, with a closing line.",
    input: chat({ ...mutation, ...revision, content: z.string().min(1) }),
    output: Loose,
    annotations: { idempotentHint: true },
    scope: "sessions:run",
  }),
  session_reopen: define("session_reopen", {
    title: "Reopen a chat's work",
    description: "Mark a chat's finished work as open again.",
    input: chat({ ...mutation, ...revision }),
    output: Loose,
    annotations: { idempotentHint: true },
    scope: "sessions:run",
  }),
  session_stop_watcher: define("session_stop_watcher", {
    title: "Stop a watcher",
    description:
      "Stop a temporary watcher a chat owns (list_watchers names them); its source and runs are kept.",
    input: chat({ ...mutation, watcherId: z.string().uuid() }),
    output: Loose,
    annotations: { destructiveHint: true, idempotentHint: true },
    scope: "sessions:run",
  }),
  /**
   * Set named values on the chat (ADR 0226, 0325): each key of `set` takes
   * its value and null removes it, with the limits and authority rules of
   * every other writer. Repeating a write changes nothing, so it needs no
   * idempotency key.
   */
  session_set_metadata: define("session_set_metadata", {
    title: "Set a chat's metadata",
    description:
      "Set named values on a chat: each key of set takes its value whole and null removes it. Repeating a write changes nothing.",
    input: chat({ ...target, set: z.record(z.string(), z.json()) }),
    output: Loose,
    annotations: { idempotentHint: true },
    scope: "sessions:run",
  }),
} as const;

export type SessionOperationName = keyof typeof SESSION_OPERATIONS;

export const SESSION_OPERATION_NAMES = Object.keys(
  SESSION_OPERATIONS,
) as SessionOperationName[];

export function isSessionOperationName(
  value: string,
): value is SessionOperationName {
  return Object.hasOwn(SESSION_OPERATIONS, value);
}

/**
 * The name a workflow calls an operation by on
 * `host["catamorphic.sessions"]`: `session_set_metadata` is `setMetadata`.
 */
export function sessionOperationHostName(name: SessionOperationName): string {
  return name
    .replace(/^session_/, "")
    .replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

/**
 * Operations a recorded action runs once per actor and idempotency key.
 * Replica memory (c): a constant, the same on every replica.
 */
const RECORDED: ReadonlySet<SessionOperationName> = new Set([
  "session_interrupt",
  "session_close",
  "session_fork",
  "session_spawn",
  "session_archive",
  "session_unarchive",
  "session_restart",
  "session_complete",
  "session_reopen",
  "session_stop_watcher",
]);

/** One call of an operation: who asks, on which surface, with what. */
export interface SessionOperationCall {
  signal?: AbortSignal;
  identity: Identity;
  /**
   * The project the surface is bound to. A server-wide surface leaves it
   * out: the chat's own project is used, or the one the input names.
   */
  projectId?: string;
  operation: SessionOperationName;
  args: unknown;
  /** Who acts: the person, their assistant, an agent, or a workflow. */
  author: SessionMessageAuthor;
  causation?: string[];
}

const tracer = getTracer("@catamorphic/core");

/**
 * Runs the session operations. Transport adapters attach identity and
 * actor, never author code; every answer a surface gives comes from here.
 */
export class SessionOperationsService {
  constructor(
    private readonly db: Kysely<DB>,
    private readonly sessions: AgentSessionsService,
    private readonly deps: {
      watchers: () => WatchersService | undefined;
      /** Whose keyed chat a caller reaches (ADR 0173). */
      chatOwner: (input: {
        caller: Identity;
        projectId: string;
        audience: ChatAudience | undefined;
      }) => Promise<Identity>;
    },
  ) {}

  /**
   * Run one operation. It throws what the service below threw; a surface
   * answers with {@link sessionOperationError} of it.
   */
  async execute(input: SessionOperationCall): Promise<Json> {
    return withSpan(
      {
        tracer,
        name: `session.operation.${input.operation}`,
        attributes: {
          ...(input.projectId
            ? { "catamorphic.project.id": input.projectId }
            : {}),
          "catamorphic.session.operation": input.operation,
        },
      },
      () => this.run(input),
    );
  }

  private async run(input: SessionOperationCall): Promise<Json> {
    switch (input.operation) {
      case "session_start":
        return this.start(
          input,
          SESSION_OPERATIONS.session_start.input.parse(input.args),
        );
      case "session_wait":
        return this.wait(
          input,
          SESSION_OPERATIONS.session_wait.input.parse(input.args),
        );
      case "session_list":
        return this.list(
          input,
          SESSION_OPERATIONS.session_list.input.parse(input.args),
        );
      default:
        return this.onChat(
          input,
          input.operation,
          SESSION_OPERATIONS[input.operation].input.parse(input.args),
        );
    }
  }

  /** The project an operation runs in: the surface's, the input's, or the chat's. */
  private async projectOf(
    input: SessionOperationCall,
    named: { project?: string; sessionId?: string },
  ): Promise<string> {
    if (input.projectId) {
      if (named.project && named.project !== input.projectId)
        throw new SessionOperationError(
          "invalid_input",
          "This connection serves one project; leave project out.",
        );
      return input.projectId;
    }
    if (named.sessionId) {
      const projectId = await this.sessions.projectOfSession({
        identity: input.identity,
        sessionId: named.sessionId,
      });
      if (named.project && named.project !== projectId)
        throw new AgentSessionNotFoundError(named.sessionId);
      return projectId;
    }
    if (named.project) return named.project;
    throw new SessionOperationError(
      "invalid_input",
      "Name the project: project_list lists the ones you may use.",
    );
  }

  private async state(
    input: SessionOperationCall,
    chat: { projectId: string; sessionId: string },
  ): Promise<SessionState> {
    const [state] = await this.sessions.states(input.identity, {
      sessions: [chat],
      detail: true,
    });
    if (!state) throw new AgentSessionNotFoundError(chat.sessionId);
    return state;
  }

  private async start(
    input: SessionOperationCall,
    args: z.infer<typeof SESSION_OPERATIONS.session_start.input>,
  ): Promise<Json> {
    const projectId = await this.projectOf(input, args);
    const key = actionKey({
      author: input.author,
      idempotencyKey: args.idempotencyKey,
    });
    const recorded = json(args);
    const earlier = await this.db
      .selectFrom("session_actions")
      .select(["id", "operation", "input", "session_id"])
      .where("project_id", "=", projectId)
      .where("idempotency_key", "=", key)
      .executeTakeFirst();
    if (
      earlier &&
      (earlier.operation !== "session_start" ||
        canonical(earlier.input) !== canonical(recorded))
    )
      throw new SessionOperationError(
        "idempotency_conflict",
        "This idempotency key was already used for another call.",
        { sessionId: earlier.session_id },
      );
    input.signal?.throwIfAborted();
    if (args.audience && !args.key)
      throw new SessionOperationError(
        "invalid_input",
        "audience applies only to a chat named by key",
      );
    // A keyed chat belongs to whoever the key serves: the caller, the
    // project, or a named member (ADR 0173). Its owner delivers.
    const owner = args.key
      ? await this.deps.chatOwner({
          caller: input.identity,
          projectId,
          audience: args.audience,
        })
      : input.identity;
    const sessionId =
      earlier?.session_id ??
      (await this.open(input, { projectId, args, owner, key }));
    const action =
      earlier ??
      (await this.db
        .insertInto("session_actions")
        .values({
          project_id: projectId,
          session_id: sessionId,
          operation: "session_start",
          actor: json({ ...input.author, causation: input.causation ?? [] }),
          input: recorded,
          idempotency_key: key,
          status: "completed",
          result: json({ sessionId }),
        })
        .onConflict((conflict) =>
          conflict.columns(["project_id", "idempotency_key"]).doNothing(),
        )
        .returning(["id", "session_id"])
        .executeTakeFirst()) ??
      (await this.db
        .selectFrom("session_actions")
        .select(["id", "session_id"])
        .where("project_id", "=", projectId)
        .where("idempotency_key", "=", key)
        .executeTakeFirstOrThrow());
    input.signal?.throwIfAborted();
    const receipt = await this.sessions.deliver(
      owner,
      projectId,
      action.session_id,
      {
        content: args.message,
        author: input.author,
        mode: "queue",
        idempotencyKey: `action:${action.id}`,
        ...(input.causation ? { causation: input.causation } : {}),
        signal: input.signal,
      },
    );
    const [state] = await this.sessions.states(owner, {
      sessions: [{ projectId, sessionId: action.session_id }],
      detail: true,
    });
    return json({
      ...state,
      sent: {
        messageId: receipt.messageId,
        turnId: receipt.turnId,
        created: receipt.created,
      },
    });
  }

  /** The chat a start delivers to: the key's open chat, or a new one. */
  private async open(
    input: SessionOperationCall,
    start: {
      projectId: string;
      args: z.infer<typeof SESSION_OPERATIONS.session_start.input>;
      owner: Identity;
      key: string;
    },
  ): Promise<string> {
    const { projectId, args, owner } = start;
    const agentId = args.agent
      ? await this.sessions.agentIdFor({ projectId, agent: args.agent })
      : undefined;
    if (args.key) {
      const keyed = await this.sessions.chatForKey(owner, projectId, {
        key: args.key,
        signal: input.signal,
        ...(agentId ? { agentId } : {}),
        ...(args.environment ? { environment: args.environment } : {}),
        ...(args.title ? { title: args.title } : {}),
        ...(args.ref ? { workspace: args.ref } : {}),
        ...(input.author.kind === "workflow"
          ? { workflowName: input.author.workflowName }
          : {}),
        origin: { author: input.author, causation: input.causation },
      });
      return keyed.sessionId;
    }
    const source: AgentSessionSource | undefined =
      input.author.kind === "assistant" ? "mcp" : undefined;
    // One chat per actor and key, on any replica: the unique source
    // action is what a retry finds, and what a concurrent call lost to.
    const sourceActionId = `start:${digest(start.key)}`;
    const created = await this.sessions
      .create(owner, projectId, {
        sourceActionId,
        ...(agentId ? { agentId } : {}),
        ...(args.model ? { model: args.model } : {}),
        ...(args.effort ? { effort: args.effort } : {}),
        ...(args.environment ? { environment: args.environment } : {}),
        ...(args.title ? { title: args.title } : {}),
        ...(args.ref ? { workspace: args.ref } : {}),
        ...(source ? { source } : {}),
        signal: input.signal,
      })
      .catch(async (error: unknown) => {
        const winner = await this.db
          .selectFrom("agent_sessions")
          .select("id")
          .where("project_id", "=", projectId)
          .where("source_action_id", "=", sourceActionId)
          .executeTakeFirst();
        if (!winner) throw error;
        return winner;
      });
    return created.id;
  }

  private async wait(
    input: SessionOperationCall,
    args: z.infer<typeof SESSION_OPERATIONS.session_wait.input>,
  ): Promise<Json> {
    const after = parseWaitCursor(args.cursor, args.sessionIds);
    const sessions = [];
    for (const sessionId of [...new Set(args.sessionIds)]) {
      const projectId = await this.projectOf(input, { sessionId });
      const cursor = after.get(sessionId);
      sessions.push({
        projectId,
        sessionId,
        ...(cursor !== undefined ? { after: cursor } : {}),
      });
    }
    const hit = await this.sessions.waitFor(input.identity, {
      sessions,
      timeoutMs: (args.timeoutSeconds ?? SESSION_WAIT_DEFAULT_SECONDS) * 1_000,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const states = await this.sessions.states(input.identity, {
      sessions,
      detail: true,
    });
    const first = states.find((state) => state.sessionId === hit) ?? states[0];
    if (!first) throw new AgentSessionNotFoundError(args.sessionIds[0] ?? "");
    const others = states.filter((state) => state !== first);
    return json({
      ...first,
      changed: hit !== null,
      // One cursor covers every watched chat: pass it back as it is.
      cursor:
        states.length === 1
          ? first.cursor
          : states
              .map((state) => `${state.sessionId}:${state.cursor}`)
              .join(","),
      ...(others.length
        ? {
            others: others.map((state) => ({
              sessionId: state.sessionId,
              state: state.state,
              cursor: state.cursor,
            })),
          }
        : {}),
    });
  }

  private async list(
    input: SessionOperationCall,
    args: z.infer<typeof SESSION_OPERATIONS.session_list.input>,
  ): Promise<Json> {
    const projectId = await this.projectOf(input, args);
    if (args.audience && !args.key)
      throw new SessionOperationError(
        "invalid_input",
        "audience applies only to a chat named by key",
      );
    if (args.key) {
      const sessionId = await this.sessions.keyedChatId({
        projectId,
        key: args.key,
        ownerId: keyedChatOwnerId({
          caller: input.identity,
          audience: args.audience,
        }),
      });
      // A key names a chat only to those who may see it.
      const found = sessionId
        ? await this.sessions
            .states(input.identity, {
              sessions: [{ projectId, sessionId }],
              detail: true,
            })
            .catch((error: unknown) => {
              if (error instanceof AccessDeniedError) return [];
              throw error;
            })
        : [];
      const sessions = found.filter(
        (state) => !args.state || state.state === args.state,
      );
      return json({ sessions, total: sessions.length, nextCursor: null });
    }
    const limit = args.limit ?? 50;
    const offset = Number.parseInt(args.cursor ?? "0", 10);
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new SessionOperationError("invalid_input", "Unknown cursor");
    const page = await this.sessions.list(input.identity, projectId, {
      limit,
      offset,
    });
    const states = await this.sessions.states(input.identity, {
      sessions: page.items.map((item) => ({ projectId, sessionId: item.id })),
      detail: false,
      listed: true,
    });
    return json({
      sessions: states.filter(
        (state) => !args.state || state.state === args.state,
      ),
      total: page.total,
      nextCursor:
        offset + page.items.length < page.total
          ? String(offset + page.items.length)
          : null,
    });
  }

  /** An operation on one chat, named by id or by key. */
  private async onChat(
    input: SessionOperationCall,
    operation: Exclude<
      SessionOperationName,
      "session_start" | "session_wait" | "session_list"
    >,
    parsed: unknown,
  ): Promise<Json> {
    const named = z
      .looseObject({
        sessionId: z.string().optional(),
        key: z.string().optional(),
        audience: ChatAudienceSchema.optional(),
        project: z.string().optional(),
        idempotencyKey: z.string().optional(),
      })
      .parse(parsed);
    const projectId = await this.projectOf(input, named);
    const keyed =
      named.key !== undefined
        ? {
            key: named.key,
            ownerId: keyedChatOwnerId({
              caller: input.identity,
              audience: named.audience,
            }),
          }
        : undefined;
    const open = keyed
      ? await this.sessions.keyedChatId({ projectId, ...keyed })
      : named.sessionId;
    // A key names a chat only to those who may see it: a chat the caller
    // cannot reach answers exactly like no chat at all.
    const read = async (sessionId: string) =>
      this.sessions
        .get(input.identity, projectId, sessionId)
        .catch((error: unknown) => {
          if (keyed && error instanceof AccessDeniedError) return null;
          throw error;
        });
    const key =
      named.idempotencyKey !== undefined
        ? actionKey({
            author: input.author,
            idempotencyKey: named.idempotencyKey,
          })
        : undefined;
    const recordedInput = json(parsed);
    // A retried mutation whose chat is gone (closed) still answers with
    // its recorded result.
    const earlier =
      !open && key !== undefined && RECORDED.has(operation)
        ? await this.db
            .selectFrom("session_actions")
            .select(["operation", "input", "result", "status", "session_id"])
            .where("project_id", "=", projectId)
            .where("idempotency_key", "=", key)
            .executeTakeFirst()
        : undefined;
    const retried =
      earlier?.operation === operation &&
      canonical(earlier.input) === canonical(recordedInput);
    if (retried && earlier?.status === "completed")
      return this.recordedAnswer(input, {
        operation,
        projectId,
        sessionId: earlier.session_id,
        result: earlier.result,
      });
    // A close that stopped after closing its chat finishes the cleanup
    // when retried, though the key no longer names the chat.
    const found =
      open ??
      (retried && operation === "session_close"
        ? (earlier?.session_id ?? undefined)
        : undefined);
    // Closing a chat that is not open has nothing left to do.
    if (!found && operation === "session_close")
      return json({ sessionId: null, closed: false });
    if (!found) throw new SessionKeyNotFoundError(keyed?.key ?? "");
    const detail = await read(found);
    if (!detail) {
      if (operation === "session_close")
        return json({ sessionId: null, closed: false });
      throw new SessionKeyNotFoundError(keyed?.key ?? "");
    }
    const chatRef = { projectId, sessionId: detail.id };
    switch (operation) {
      case "session_read":
        return this.read(
          input,
          chatRef,
          SESSION_OPERATIONS.session_read.input.parse(parsed),
        );
      case "session_send": {
        const args = SESSION_OPERATIONS.session_send.input.parse(parsed);
        const receipt = await this.sessions.deliver(
          input.identity,
          projectId,
          detail.id,
          {
            content: args.message,
            author: input.author,
            mode: args.mode ?? "queue",
            ...(args.attention ? { attention: args.attention } : {}),
            idempotencyKey: `send:${digest(key ?? "")}`,
            ...(input.causation ? { causation: input.causation } : {}),
            ...(args.ref ? { workspace: args.ref } : {}),
            signal: input.signal,
          },
        );
        return json({
          ...(await this.state(input, chatRef)),
          sent: {
            messageId: receipt.messageId,
            turnId: receipt.turnId,
            created: receipt.created,
          },
        });
      }
      case "session_answer": {
        const args = SESSION_OPERATIONS.session_answer.input.parse(parsed);
        const receipt = await this.sessions.command(
          input.identity,
          projectId,
          detail.id,
          {
            type: "respond",
            commandId: `answer:${digest(key ?? "")}`,
            requestId: args.requestId,
            response: args.response,
          },
        );
        if (receipt.status === "rejected")
          throw new SessionOperationError(
            receipt.error?.code === "not_found"
              ? "not_found"
              : "request_not_pending",
            receipt.error?.message ?? "That request cannot be answered.",
            { sessionId: detail.id },
          );
        return json(await this.state(input, chatRef));
      }
      case "session_set_metadata": {
        input.signal?.throwIfAborted();
        const metadata = await this.sessions.setMetadata({
          identity: input.identity,
          projectId,
          sessionId: detail.id,
          values:
            SESSION_OPERATIONS.session_set_metadata.input.parse(parsed).set,
        });
        return json({ sessionId: detail.id, metadata });
      }
      default:
        return this.recorded(input, {
          operation,
          projectId,
          session: detail,
          parsed,
          recordedInput,
          key,
        });
    }
  }

  private async read(
    input: SessionOperationCall,
    chatRef: { projectId: string; sessionId: string },
    args: z.infer<typeof SESSION_OPERATIONS.session_read.input>,
  ): Promise<Json> {
    const { projectId, sessionId } = chatRef;
    const include = new Set(args.include ?? []);
    const state = await this.state(input, chatRef);
    const sections: Record<string, unknown> = {};
    if (include.has("metadata"))
      sections.metadata = await this.sessions.metadata({
        identity: input.identity,
        projectId,
        sessionId,
      });
    if (include.has("transcript")) {
      const messages = await this.sessions.transcript(
        input.identity,
        projectId,
        sessionId,
        {
          ...(args.through ? { through: args.through } : {}),
          limit: args.limit ?? 30,
        },
      );
      if (
        args.through &&
        !messages.some((message) => message.id === args.through)
      )
        throw new SessionOperationError(
          "not_found",
          "No message in this chat has that id",
          { sessionId },
        );
      sections.transcript = messages;
    }
    if (include.has("results"))
      sections.results = (
        await this.sessions.results(input.identity, projectId, sessionId, {
          ...(args.name ? { name: args.name } : {}),
          ...(args.family ? { family: true } : {}),
          ...(args.turnId ? { turnId: args.turnId } : {}),
          ...(args.afterInput ? { afterInput: args.afterInput } : {}),
          ...(args.limit ? { limit: args.limit } : {}),
          ...(args.order === "oldest" ? { order: "oldest" as const } : {}),
        })
      ).map((result) => ({
        id: result.id,
        name: result.name,
        value: result.value,
        turnId: result.turnId,
        current: result.current,
        recordedAt: result.recordedAt,
        sessionId: result.sessionId,
        attemptId: result.attemptId,
        input: result.input,
        commit: result.commit,
      }));
    if (include.has("usage"))
      sections.usage = await this.sessions.usage({
        identity: input.identity,
        projectId,
        sessionId,
        family: args.family === true,
      });
    if (include.has("attempts")) {
      if (!args.turnId)
        throw new SessionOperationError(
          "invalid_input",
          "Reading attempts needs turnId",
          { sessionId },
        );
      sections.attempts = await this.sessions.attempts(
        input.identity,
        projectId,
        sessionId,
        { turnId: args.turnId },
      );
    }
    return json({ ...state, ...sections });
  }

  /** What a recorded operation answers: its result, with the chat's state where one is promised. */
  private async recordedAnswer(
    input: SessionOperationCall,
    answer: {
      operation: SessionOperationName;
      projectId: string;
      sessionId: string;
      result: Json;
    },
  ): Promise<Json> {
    if (
      answer.operation !== "session_interrupt" &&
      answer.operation !== "session_close"
    )
      return answer.result;
    const result =
      answer.result && typeof answer.result === "object" ? answer.result : {};
    const [state] = await this.sessions
      .states(input.identity, {
        sessions: [
          { projectId: answer.projectId, sessionId: answer.sessionId },
        ],
        detail: true,
      })
      .catch(() => []);
    return json({ ...state, ...result });
  }

  /**
   * A mutation recorded as a session action: at most once per actor and
   * idempotency key on any replica, and visible in the chat it changed.
   */
  private async recorded(
    input: SessionOperationCall,
    call: {
      operation: SessionOperationName;
      projectId: string;
      session: Awaited<ReturnType<AgentSessionsService["get"]>>;
      parsed: unknown;
      recordedInput: Json;
      key: string | undefined;
    },
  ): Promise<Json> {
    const { operation, projectId, session, key } = call;
    if (key === undefined)
      throw new SessionOperationError(
        "invalid_input",
        "idempotencyKey is required",
      );
    const sessionId = session.id;
    const args = { ...z.looseObject({}).parse(call.parsed), sessionId };
    const origin = { author: input.author, causation: input.causation };
    // Everything past this point changes the session: settle access
    // before the action is recorded, so a denied caller leaves no trace.
    await this.sessions.assertSession(
      input.identity,
      projectId,
      sessionId,
      "change",
    );
    input.signal?.throwIfAborted();
    const turnId = z
      .object({ turnId: z.string().optional() })
      .parse(args).turnId;
    const accepted = await this.db
      .insertInto("session_actions")
      .values({
        project_id: projectId,
        session_id: sessionId,
        operation,
        target_turn_id:
          operation === "session_interrupt"
            ? this.db
                .selectFrom("agent_turns")
                .select("id")
                .where("session_id", "=", sessionId)
                .$if(turnId !== undefined, (query) =>
                  query.where("id", "=", turnId ?? ""),
                )
                .where("status", "in", [
                  "preparing",
                  "running",
                  "waiting",
                  "finalizing",
                ])
                .limit(1)
            : null,
        actor: json({ ...input.author, causation: input.causation ?? [] }),
        input: call.recordedInput,
        idempotency_key: key,
      })
      .onConflict((conflict) =>
        conflict.columns(["project_id", "idempotency_key"]).doNothing(),
      )
      .returningAll()
      .executeTakeFirst();
    const action =
      accepted ??
      (await this.db
        .selectFrom("session_actions")
        .selectAll()
        .where("project_id", "=", projectId)
        .where("idempotency_key", "=", key)
        .executeTakeFirstOrThrow());
    // Compare JSON semantically: jsonb property order is not source order.
    if (
      action.operation !== operation ||
      canonical(action.input) !== canonical(call.recordedInput)
    )
      throw new SessionOperationError(
        "idempotency_conflict",
        "This idempotency key was already used for another action",
        { sessionId },
      );
    if (action.status === "completed")
      return this.recordedAnswer(input, {
        operation,
        projectId,
        sessionId,
        result: action.result,
      });
    input.signal?.throwIfAborted();
    const expected = z
      .object({ expectedStateRevision: z.number().optional() })
      .parse(args).expectedStateRevision;
    if (expected !== undefined && expected !== session.stateRevision)
      throw new Error(
        "Session state changed; inspect it before retrying this action",
      );
    if (
      session.authorityHostId !== this.sessions.hostId &&
      session.authorityHostId !== "unassigned"
    ) {
      const receipt = await this.sessions.mailboxes.enqueue(
        input.identity,
        projectId,
        sessionId,
        {
          signal: input.signal,
          destination: {
            hostId: session.authorityHostId,
            revision: session.authorityRevision,
          },
          delivery: {
            kind: "action",
            action: {
              operation,
              args: protocolJson(args),
              actor: input.author,
            },
          },
          idempotencyKey: `action:${action.id}`,
          causation: input.causation ?? [],
        },
      );
      return operation === "session_interrupt" || operation === "session_close"
        ? json({
            ...(await this.state(input, { projectId, sessionId })),
            ...(operation === "session_interrupt"
              ? { interrupted: false }
              : { closed: false }),
            forwarded: true,
          })
        : json({ delivery: "queued", ...receipt });
    }
    const leaseOwner = randomUUID();
    const claim = await this.db
      .updateTable("session_actions")
      .set({
        status: "running",
        lease_owner: leaseOwner,
        lease_expires_at: new Date(Date.now() + 120_000),
        updated_at: new Date(),
      })
      .where("id", "=", action.id)
      .where(({ or, eb }) =>
        or([
          eb("status", "in", ["pending", "failed"]),
          eb("lease_expires_at", "<=", new Date()),
        ]),
      )
      .returning("id")
      .executeTakeFirst();
    if (!claim)
      throw new SessionOperationError(
        "internal",
        "Session action is already running; retry with the same idempotency key",
        { retryable: true, sessionId },
      );
    const renewal = setInterval(() => {
      void this.db
        .updateTable("session_actions")
        .set({ lease_expires_at: new Date(Date.now() + 120_000) })
        .where("id", "=", action.id)
        .where("status", "=", "running")
        .where("lease_owner", "=", leaseOwner)
        .execute()
        .catch(() => {});
    }, 30_000);
    try {
      input.signal?.throwIfAborted();
      const sourceActionId = `action:${action.id}`;
      let result: unknown;
      switch (operation) {
        case "session_fork":
          result = await this.sessions.fork(
            input.identity,
            projectId,
            sessionId,
            {
              ...SESSION_OPERATIONS.session_fork.input.parse(call.parsed),
              sourceActionId,
              signal: input.signal,
            },
          );
          break;
        case "session_spawn":
          result = await this.sessions.createSubsession(
            input.identity,
            projectId,
            sessionId,
            {
              ...SESSION_OPERATIONS.session_spawn.input.parse(call.parsed),
              sourceActionId,
              origin,
              signal: input.signal,
            },
          );
          break;
        case "session_archive":
          result = await this.sessions.archive(
            input.identity,
            projectId,
            sessionId,
            {
              ...SESSION_OPERATIONS.session_archive.input.parse(call.parsed),
              origin,
              signal: input.signal,
            },
          );
          break;
        case "session_unarchive":
          result = await this.sessions.unarchive(
            input.identity,
            projectId,
            sessionId,
            { origin, signal: input.signal },
          );
          break;
        case "session_close":
          // Repeating a close finishes what an interrupted one left;
          // only closing an open chat, or retrying that, reports it.
          await this.sessions.close(input.identity, projectId, sessionId, {
            origin,
            signal: input.signal,
          });
          result = {
            sessionId,
            closed: session.status !== "closed" || !accepted,
          };
          break;
        case "session_interrupt":
          if (action.target_turn_id)
            await this.sessions.interrupt(
              input.identity,
              projectId,
              sessionId,
              { turnId: action.target_turn_id, signal: input.signal },
            );
          result = { interrupted: action.target_turn_id !== null };
          break;
        case "session_restart": {
          const restart = SESSION_OPERATIONS.session_restart.input.parse(
            call.parsed,
          );
          result = await this.sessions.restartTurn(
            input.identity,
            projectId,
            sessionId,
            {
              turnId: restart.turnId,
              attemptId: restart.attemptId,
              reason: restart.reason,
              ...(restart.onlyIfStalled !== undefined
                ? { onlyIfStalled: restart.onlyIfStalled }
                : {}),
              signal: input.signal,
            },
          );
          break;
        }
        case "session_stop_watcher":
          result = {
            stopped: await this.deps.watchers()?.stop({
              identity: input.identity,
              projectId,
              sessionId,
              signal: input.signal,
              watcherId: SESSION_OPERATIONS.session_stop_watcher.input.parse(
                call.parsed,
              ).watcherId,
            }),
          };
          break;
        default:
          result = { sessionId };
          break;
      }
      const content = z
        .object({ content: z.string().optional() })
        .parse(args).content;
      await this.db.transaction().execute(async (trx) => {
        const owned = await trx
          .selectFrom("session_actions")
          .select("id")
          .where("id", "=", action.id)
          .where("status", "=", "running")
          .where("lease_owner", "=", leaseOwner)
          .forUpdate()
          .executeTakeFirst();
        if (!owned) throw new Error("Session action lease was replaced");
        input.signal?.throwIfAborted();
        await sql`select set_config('catamorphic.session_actor', ${jsonbText({ ...input.author, causation: input.causation ?? [] })}, true)`.execute(
          trx,
        );
        const settlesWork =
          operation === "session_complete" || operation === "session_reopen";
        if (settlesWork) {
          const current = await trx
            .selectFrom("agent_sessions")
            .select("state_revision")
            .where("id", "=", sessionId)
            .forUpdate()
            .executeTakeFirstOrThrow();
          if (
            expected !== undefined &&
            Number(current.state_revision) !== expected
          )
            throw new Error(
              "Session state changed; inspect it before retrying this action",
            );
          input.signal?.throwIfAborted();
          await trx
            .updateTable("agent_sessions")
            .set({
              work_status:
                operation === "session_complete" ? "completed" : "open",
              updated_at: new Date(),
            })
            .where("id", "=", sessionId)
            .execute();
        }
        await this.sessions.recordActionWithin(trx, {
          sessionId,
          actionId: action.id,
          status: "completed",
          actor: input.author,
          text: content ?? ACTION_LABELS[operation] ?? operation,
          data: {
            sessionAction: {
              id: action.id,
              operation,
              status: "completed",
              result: json(result),
            },
            causation: input.causation ?? [],
          },
        });
        await trx
          .updateTable("session_actions")
          .set({
            status: "completed",
            result: json(result),
            error: null,
            lease_expires_at: null,
            lease_owner: null,
            updated_at: new Date(),
          })
          .where("id", "=", action.id)
          .execute();
        input.signal?.throwIfAborted();
      });
      return this.recordedAnswer(input, {
        operation,
        projectId,
        sessionId,
        result: json(result),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.db.transaction().execute(async (trx) => {
        const failed = await trx
          .updateTable("session_actions")
          .set({
            status: "failed",
            error: message,
            lease_expires_at: null,
            lease_owner: null,
            updated_at: new Date(),
          })
          .where("id", "=", action.id)
          .where("status", "=", "running")
          .where("lease_owner", "=", leaseOwner)
          .returning("id")
          .executeTakeFirst();
        if (!failed) return;
        await this.sessions.recordActionWithin(trx, {
          sessionId,
          actionId: action.id,
          status: "failed",
          actor: input.author,
          text: `${ACTION_LABELS[operation] ?? operation} failed: ${message}`,
          data: {
            sessionAction: { id: action.id, operation, status: "failed" },
            causation: input.causation ?? [],
          },
        });
      });
      throw error;
    } finally {
      clearInterval(renewal);
    }
  }
}

/** The line a recorded action leaves in its chat. */
const ACTION_LABELS: Partial<Record<SessionOperationName, string>> = {
  session_fork: "Forked this session",
  session_spawn: "Created a child session",
  session_archive: "Archived this session",
  session_unarchive: "Unarchived this session",
  session_close: "Closed this chat",
  session_interrupt: "Interrupted this session",
  session_restart: "Restarted the agent's attempt",
  session_complete: "Marked work finished",
  session_reopen: "Reopened the work",
  session_stop_watcher: "Stopped a watcher",
};

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Each watched chat's position from a wait's cursor: one chat's own
 * sequence (`412`), or the list a wait over several returned
 * (`<sessionId>:<sequence>,...`).
 */
export function parseWaitCursor(
  cursor: string | undefined,
  sessionIds: readonly string[],
): Map<string, number> {
  const after = new Map<string, number>();
  if (cursor === undefined || cursor.trim() === "") return after;
  const refuse = () =>
    new SessionOperationError(
      "invalid_input",
      "Unknown cursor: pass the cursor the last call for these chats returned, or leave it out.",
    );
  const sequence = (text: string) => {
    const value = Number(text);
    if (!/^\d+$/.test(text) || !Number.isSafeInteger(value)) throw refuse();
    return value;
  };
  if (!cursor.includes(":")) {
    const [only] = sessionIds;
    if (sessionIds.length !== 1 || !only) throw refuse();
    after.set(only, sequence(cursor.trim()));
    return after;
  }
  for (const part of cursor.split(",")) {
    const [sessionId, position, ...rest] = part.trim().split(":");
    if (!sessionId || position === undefined || rest.length > 0) throw refuse();
    if (sessionIds.includes(sessionId))
      after.set(sessionId, sequence(position));
  }
  return after;
}

/**
 * The key an action is recorded under: who acted and the caller's key. The
 * only way to build it, for the record and for every lookup of it.
 */
export function actionKey(input: {
  author: SessionMessageAuthor;
  idempotencyKey: string;
}): string {
  return JSON.stringify([actorIdentity(input.author), input.idempotencyKey]);
}
/**
 * Who acted, without a workflow run's circumstances (its enablement,
 * watcher and schedule): the run is the actor, and its actions keep the
 * key they had before the sender carried those.
 */
function actorIdentity(author: SessionMessageAuthor): SessionMessageAuthor {
  if (author.kind !== "workflow") return author;
  return {
    kind: "workflow",
    runId: author.runId,
    workflowName: author.workflowName,
    ...(author.displayName ? { displayName: author.displayName } : {}),
  };
}

/**
 * A value as jsonb stores it, so an action compares equal to its own stored
 * copy: half of a surrogate pair and U+0000 are U+FFFD there.
 */
export function json(value: unknown): Json {
  return JSON.parse(jsonbText(value));
}
export function canonical(value: Json): string {
  if (Array.isArray(value)) return JSON.stringify(value.map(canonical));
  if (value && typeof value === "object")
    return JSON.stringify(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key] ?? null)]),
    );
  return JSON.stringify(value);
}
