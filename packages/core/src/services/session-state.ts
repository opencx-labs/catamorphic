import {
  ACTIVE_TURN_STATUSES,
  type RuntimeRequest,
  sessionPullRequests,
  type Turn,
} from "@catamorphic/agent-protocol";
import type { DB, Json } from "@catamorphic/db";
import { type Kysely, sql, type Transaction } from "kysely";
import { z } from "zod";
import { isProjectPrincipal } from "../identity.js";
import {
  PLACEMENT_WAIT_FRESH_SECONDS,
  PlacementWaitMachineSchema,
} from "./placement-waits.js";
import { parseWorkspaceBase } from "./session-workspaces.js";
import { latestResults } from "./sessions/session-results.js";
import {
  requestFromRow,
  type SessionRow,
  sessionMetadataFromRow,
  turnFromRow,
} from "./sessions/session-rows.js";
import { turnState } from "./sessions/turn-stalls.js";

type Executor = Kysely<DB> | Transaction<DB>;

/**
 * Where a chat stands for whoever controls it (ADR 0346): `working` while
 * a turn runs or waits to run, `needs_input` while its agent waits on an
 * answer, `failed` when its latest turn failed, `closed` at the end of its
 * life, `idle` otherwise.
 */
export const SESSION_STATES = [
  "working",
  "needs_input",
  "idle",
  "failed",
  "closed",
] as const;
export type SessionStateName = (typeof SESSION_STATES)[number];

const TurnSchema = z.object({
  id: z.string(),
  status: z.string(),
  /** The line the chat shows while it works. */
  activity: z.string().nullable(),
  /** When its attempt last made progress (ADR 0333). */
  progressAt: z.string().nullable(),
  /** Set while a silence longer than the agent's stall threshold lasts. */
  stalledAt: z.string().nullable(),
  ordinal: z.number().int().optional(),
  attempt: z
    .object({
      id: z.string(),
      ordinal: z.number().int(),
      reason: z.string(),
      startedAt: z.string().nullable(),
    })
    .nullable()
    .optional(),
  attempts: z.number().int().optional(),
  restarts: z.number().int().optional(),
  stallMinutes: z.number().nullable().optional(),
  /** The tool calls and commands the attempt reported still running. */
  running: z
    .object({
      tools: z.array(
        z.object({
          name: z.string(),
          description: z.string().nullable(),
          since: z.string(),
        }),
      ),
      commands: z.array(
        z.object({
          command: z.string(),
          description: z.string().nullable(),
          since: z.string(),
        }),
      ),
    })
    .optional(),
});

const RequestSchema = z.object({
  requestId: z.string(),
  kind: z.enum(["question", "approval", "elicitation"]),
  title: z.string(),
  description: z.string().nullable(),
  /** Whether the agent waits on the answer. */
  blocking: z.boolean(),
  turnId: z.string().nullable(),
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
          input: z.unknown(),
        })
        .optional(),
    })
    .nullable(),
  elicitation: z
    .object({
      server: z.string(),
      message: z.string(),
      schema: z.record(z.string(), z.unknown()).optional(),
      url: z.string().optional(),
    })
    .nullable(),
  expiresAt: z.string().nullable(),
});
export type SessionStateRequest = z.infer<typeof RequestSchema>;

const ResultSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Null when `truncated`: read it whole with `include: ["results"]`. */
  value: z.unknown(),
  turnId: z.string().nullable(),
  /** No newer request reached the chat after the input it answers. */
  current: z.boolean(),
  truncated: z.boolean().optional(),
  recordedAt: z.string(),
  /** The chat that recorded it: the one read, or one of its subsessions. */
  sessionId: z.string(),
  attemptId: z.string().nullable(),
  /** The newest input the chat had taken in when it was submitted. */
  input: z
    .object({ itemId: z.string(), position: z.number(), kind: z.string() })
    .nullable(),
  /** The workspace commit the submitting turn began on, when there is one. */
  commit: z.string().nullable(),
});

const PullRequestSchema = z.object({
  url: z.string(),
  number: z.number().optional(),
  title: z.string().optional(),
  state: z.enum(["open", "draft", "merged", "closed"]).optional(),
});

const TranscriptMessageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "inbound", "notification", "assistant", "system"]),
  content: z.string(),
  turnId: z.string().nullable(),
  status: z.string(),
  createdAt: z.string(),
  author: z.record(z.string(), z.unknown()).nullable(),
});

/**
 * One chat as every surface reads it (ADR 0346): the answer of every
 * session operation, over REST, MCP, in-product tools and workflows.
 */
export const SessionStateSchema = z.object({
  sessionId: z.string(),
  projectId: z.string(),
  title: z.string().nullable(),
  /** The agent's id (`project:<projectId>:<slug>` for a project agent). */
  agent: z.string().nullable(),
  /** The Environment it runs in, known before a machine is placed. */
  environment: z.string().nullable(),
  state: z.enum(SESSION_STATES),
  /** Pass it to `session_wait` to hear only what happens after this. */
  cursor: z.string(),
  /** The turn working now; null when none works. */
  turn: TurnSchema.nullable(),
  /** Turns waiting to run, oldest first. */
  queued: z.array(z.string()),
  /** What the agent asks and still waits on. */
  requests: z.array(RequestSchema),
  /** The latest turn's last assistant text once it settled, else null. */
  reply: z.string().nullable(),
  /** The latest accepted typed result of each name (ADR 0323). */
  results: z.array(ResultSchema),
  pullRequests: z.array(PullRequestSchema),
  /** Why the latest turn failed. */
  error: z
    .object({ kind: z.string().nullable(), message: z.string() })
    .nullable(),
  /** Why its work has not started: it waits for a machine (ADR 0258). */
  waiting: z
    .object({
      reason: z.enum(["capacity", "unavailable"]),
      message: z.string(),
      environment: z.string(),
      machine: PlacementWaitMachineSchema.optional(),
      since: z.string(),
      /** When the wait gives up and the turn fails; null to wait on. */
      expiresAt: z.string().nullable(),
    })
    .nullable(),
  /** Something here waits on its person, and they have not seen it. */
  attentionRequired: z.boolean(),
  /** The project's key for the chat (ADR 0173), or null. */
  key: z.string().nullable(),
  owner: z.enum(["project", "member"]),
  keyWorkflows: z.array(z.string()),
  placement: z
    .object({
      environment: z.string(),
      reason: z.string(),
      machine: z.object({ id: z.string(), label: z.string() }),
    })
    .nullable(),
  /**
   * The base its workspace stands on (ADR 0178): the ref of the project's
   * remote it started at or last moved to, and that ref's commit then.
   */
  workspace: z.object({ ref: z.string(), commit: z.string() }).nullable(),
  parentSessionId: z.string().nullable(),
  workStatus: z.enum(["open", "completed"]),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** Where a person opens the chat, when the host has a public address. */
  url: z.string().optional(),
  /** From `session_wait`: false when the wait timed out with nothing new. */
  changed: z.boolean().optional(),
  /** With `include: ["metadata"]`: the chat's named values (ADR 0226). */
  metadata: z.record(z.string(), z.unknown()).optional(),
  /** With `include: ["transcript"]`: the conversation, oldest first. */
  transcript: z.array(TranscriptMessageSchema).optional(),
  /** With `include: ["usage"]`: model usage through the gateway (ADR 0329). */
  usage: z.record(z.string(), z.unknown()).optional(),
  /** With `include: ["attempts"]` and `turnId`: that turn's attempts. */
  attempts: z.array(z.record(z.string(), z.unknown())).optional(),
});
export type SessionState = z.infer<typeof SessionStateSchema>;

const nullable = (type: string) => ({ type: [type, "null"] });

/**
 * What a tool declares it answers with (ADR 0347): the fields a caller
 * acts on, each with a line saying what it is for, and nothing of the
 * shapes below them. Clients hand a tool's output schema to their model,
 * so this stays small; {@link SessionStateSchema} is the whole shape, and
 * what the answers are checked against.
 */
export const SESSION_STATE_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    sessionId: { type: "string" },
    projectId: { type: "string" },
    title: nullable("string"),
    agent: nullable("string"),
    state: {
      enum: [...SESSION_STATES],
      description:
        "working: wait again. needs_input: answer requests. idle: read reply. failed: read error.",
    },
    cursor: {
      type: "string",
      description: "Pass to session_wait to hear only what happens next",
    },
    turn: {
      ...nullable("object"),
      description: "The turn working now: id, status, activity, stalledAt",
    },
    requests: {
      type: "array",
      items: { type: "object" },
      description:
        "What the agent asks: requestId, kind (question, approval, elicitation), title, questions",
    },
    reply: {
      ...nullable("string"),
      description: "The latest turn's last assistant text, once it settled",
    },
    results: {
      type: "array",
      items: { type: "object" },
      description: "Typed results: name, value, turnId, current",
    },
    pullRequests: {
      type: "array",
      items: { type: "object" },
      description: "Pull requests the chat opened: url, number, title, state",
    },
    error: {
      ...nullable("object"),
      description: "Why the latest turn failed: kind, message",
    },
    waiting: {
      ...nullable("object"),
      description: "Set while it waits for a machine: reason, message, since",
    },
    attentionRequired: { type: "boolean" },
    url: { type: "string", description: "Where a person opens the chat" },
  },
  required: ["sessionId", "projectId", "state", "cursor"],
} as const;

/** {@link SESSION_STATE_OUTPUT_SCHEMA} with a tool's own fields beside it. */
export function sessionStateOutputSchema(
  extra: Record<string, unknown> = {},
  required: readonly string[] = SESSION_STATE_OUTPUT_SCHEMA.required,
): Record<string, unknown> {
  return {
    ...SESSION_STATE_OUTPUT_SCHEMA,
    properties: { ...SESSION_STATE_OUTPUT_SCHEMA.properties, ...extra },
    required: [...required],
  };
}

const WAITING_MESSAGES = {
  capacity: "Waiting for a machine with room",
  unavailable: "Waiting for a machine to come online",
} as const;

/** How much of a listed chat's reply a list carries. */
const LISTED_REPLY_CHARACTERS = 500;

function requestOf(request: RuntimeRequest): SessionStateRequest {
  return {
    requestId: request.id,
    kind: request.kind,
    title: request.title,
    description: request.description,
    blocking: request.blocking,
    turnId: request.turnId,
    questions: request.questions,
    approval: request.approval,
    elicitation: request.elicitation
      ? {
          server: request.elicitation.server,
          message: request.elicitation.message,
          ...(request.elicitation.schema
            ? { schema: request.elicitation.schema }
            : {}),
          ...(request.elicitation.url ? { url: request.elicitation.url } : {}),
        }
      : null,
    expiresAt: request.expiresAt,
  };
}

function stringList(value: Json): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function placementOf(value: Json | null): SessionState["placement"] {
  const parsed = z
    .object({
      environment: z.string(),
      reason: z.string(),
      machine: z.object({ id: z.string(), label: z.string() }),
    })
    .safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Where a chat stands, from what is open in it. */
export function sessionStateName(input: {
  status: string;
  /** Statuses of its turns that have not settled. */
  open: readonly string[];
  /** Its latest turn's status, or null when it has none. */
  latest: string | null;
  /** A pending request its agent waits on. */
  asked: boolean;
}): SessionStateName {
  if (input.status === "closed") return "closed";
  if (input.asked) return "needs_input";
  const working = input.open.some(
    (status) =>
      status === "queued" ||
      ACTIVE_TURN_STATUSES.some((active) => active === status),
  );
  if (working) return "working";
  return input.latest === "failed" ? "failed" : "idle";
}

/**
 * The state of each chat, in the order given (ADR 0346). `detail` adds
 * what one chat's reader wants and a list does not: the working turn's
 * progress, the whole reply and the latest typed results.
 */
export async function readSessionStates(
  db: Executor,
  input: {
    rows: readonly SessionRow[];
    detail: boolean;
    sessionUrl?: (chat: {
      projectId: string;
      sessionId: string;
    }) => string | undefined;
  },
): Promise<SessionState[]> {
  const ids = input.rows.map((row) => row.id);
  if (ids.length === 0) return [];
  const open = await db
    .selectFrom("agent_turns")
    .select(["id", "session_id", "ordinal", "status", "activity"])
    .where("session_id", "in", ids)
    .where("status", "in", [...ACTIVE_TURN_STATUSES, "queued", "held"])
    .orderBy("ordinal")
    .execute();
  const latestRows = await db
    .selectFrom("agent_turns")
    .selectAll()
    .distinctOn("session_id")
    .where("session_id", "in", ids)
    .orderBy("session_id")
    .orderBy("ordinal", "desc")
    .execute();
  const latest = new Map<string, Turn>(
    latestRows.map((row) => [row.session_id, turnFromRow(row)]),
  );
  const pending = (
    await db
      .selectFrom("agent_runtime_requests")
      .selectAll()
      .where("session_id", "in", ids)
      .where("status", "=", "pending")
      .where("answerable", "=", true)
      .orderBy("created_at")
      .execute()
  ).map(requestFromRow);
  const waits = await db
    .selectFrom("placement_waits")
    .select([
      "root_workload_id",
      "environment_name",
      "reason",
      "waiting_since",
      "expires_at",
      "machine",
    ])
    .where("root_workload_id", "in", ids)
    .where(
      "last_tried_at",
      ">",
      sql<Date>`now() - make_interval(secs => ${PLACEMENT_WAIT_FRESH_SECONDS})`,
    )
    .execute();
  const settled = [...latest.values()].filter(
    (turn) => turn.status === "completed" || turn.status === "failed",
  );
  const replies = settled.length
    ? await db
        .selectFrom("agent_items")
        .select(["turn_id", "text"])
        .distinctOn("turn_id")
        .where(
          "turn_id",
          "in",
          settled.map((turn) => turn.id),
        )
        .where("kind", "=", "assistant_message")
        .orderBy("turn_id")
        .orderBy("position", "desc")
        .execute()
    : [];
  const replyOf = new Map(replies.map((row) => [row.turn_id, row.text]));
  const results = input.detail ? await latestResults(db, ids) : new Map();
  const states: SessionState[] = [];
  for (const row of input.rows) {
    const turns = open.filter((turn) => turn.session_id === row.id);
    const last = latest.get(row.id) ?? null;
    const requests = pending.filter((request) => request.sessionId === row.id);
    const state = sessionStateName({
      status: row.status,
      open: turns.map((turn) => turn.status),
      latest: last?.status ?? null,
      asked: requests.some((request) => request.blocking),
    });
    const active = turns.find((turn) =>
      ACTIVE_TURN_STATUSES.some((status) => status === turn.status),
    );
    const progress =
      active && input.detail ? (await turnState(db, row.id)).turn : null;
    const wait = waits.find((entry) => entry.root_workload_id === row.id);
    const reason = wait?.reason === "unavailable" ? "unavailable" : "capacity";
    const machine = PlacementWaitMachineSchema.safeParse(wait?.machine).data;
    const reply =
      last && turns.length === 0 ? (replyOf.get(last.id) ?? null) : null;
    const metadata = sessionMetadataFromRow(row.metadata);
    const url = input.sessionUrl?.({
      projectId: row.project_id,
      sessionId: row.id,
    });
    states.push({
      sessionId: row.id,
      projectId: row.project_id,
      title: row.title,
      agent: row.agent_id,
      environment: row.environment_name,
      state,
      cursor: String(row.event_sequence),
      turn: active
        ? {
            id: active.id,
            status: active.status,
            activity: active.activity,
            progressAt: progress?.progressAt ?? null,
            stalledAt: progress?.stalledAt ?? null,
            ...(progress
              ? {
                  ordinal: progress.ordinal,
                  attempt: progress.attempt,
                  attempts: progress.attempts,
                  restarts: progress.restarts,
                  stallMinutes: progress.stallMinutes,
                  running: progress.activity,
                }
              : {}),
          }
        : null,
      queued: turns
        .filter((turn) => turn.status === "queued" || turn.status === "held")
        .map((turn) => turn.id)
        .slice(0, 100),
      requests: requests.map(requestOf),
      reply:
        reply !== null && !input.detail
          ? reply.slice(0, LISTED_REPLY_CHARACTERS)
          : reply,
      results: (results.get(row.id) ?? []).map(
        (result: {
          id: string;
          name: string;
          value: z.infer<typeof ResultSchema>["value"];
          truncated: boolean;
          current: boolean;
          turnId: string | null;
          attemptId: string | null;
          input: z.infer<typeof ResultSchema>["input"];
          commit: string | null;
          recordedAt: string;
        }) => ({
          id: result.id,
          name: result.name,
          value: result.value,
          turnId: result.turnId,
          current: result.current,
          ...(result.truncated ? { truncated: true } : {}),
          recordedAt: result.recordedAt,
          sessionId: row.id,
          attemptId: result.attemptId,
          input: result.input,
          commit: result.commit,
        }),
      ),
      pullRequests: sessionPullRequests(metadata),
      error:
        state === "failed" && last
          ? {
              kind: last.error?.kind ?? null,
              message: last.error?.message ?? "The turn failed.",
            }
          : null,
      waiting:
        wait && state === "working" && !active
          ? {
              reason,
              message: machine
                ? `${machine.state === "starting" ? "Starting" : "Resuming"} machine ${machine.name}`
                : WAITING_MESSAGES[reason],
              ...(machine ? { machine } : {}),
              environment: wait.environment_name,
              since: wait.waiting_since.toISOString(),
              expiresAt: wait.expires_at?.toISOString() ?? null,
            }
          : null,
      attentionRequired:
        Number(row.attention_revision) > Number(row.attention_seen_revision),
      key: row.chat_key,
      owner: isProjectPrincipal(row.external_user_id) ? "project" : "member",
      keyWorkflows: stringList(row.chat_workflows),
      placement: placementOf(row.placement),
      workspace: parseWorkspaceBase(row.workspace),
      parentSessionId: row.parent_session_id,
      workStatus: row.work_status === "completed" ? "completed" : "open",
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      ...(url ? { url } : {}),
    });
  }
  return states;
}

/**
 * What a waiter compares (ADR 0347): each chat's log position and where it
 * stands, in two queries however many chats are watched.
 */
export async function readSessionPhases(
  db: Executor,
  sessionIds: readonly string[],
): Promise<Map<string, { sequence: number; state: SessionStateName }>> {
  const phases = new Map<
    string,
    { sequence: number; state: SessionStateName }
  >();
  if (sessionIds.length === 0) return phases;
  const rows = await db
    .selectFrom("agent_sessions as session")
    .select((eb) => [
      "session.id",
      "session.status",
      "session.event_sequence",
      eb
        .selectFrom("agent_turns as turn")
        .select(
          sql<Json>`coalesce(jsonb_agg(turn.status), '[]'::jsonb)`.as("open"),
        )
        .whereRef("turn.session_id", "=", "session.id")
        .where("turn.status", "in", [...ACTIVE_TURN_STATUSES, "queued", "held"])
        .as("open"),
      eb
        .selectFrom("agent_turns as turn")
        .select("turn.status")
        .whereRef("turn.session_id", "=", "session.id")
        .orderBy("turn.ordinal", "desc")
        .limit(1)
        .as("latest"),
      eb
        .exists(
          eb
            .selectFrom("agent_runtime_requests as request")
            .select("request.request_id")
            .whereRef("request.session_id", "=", "session.id")
            .where("request.status", "=", "pending")
            .where("request.answerable", "=", true)
            .where("request.blocking", "=", true),
        )
        .as("asked"),
    ])
    .where("session.id", "in", [...sessionIds])
    .execute();
  for (const row of rows)
    phases.set(row.id, {
      sequence: Number(row.event_sequence),
      state: sessionStateName({
        status: row.status,
        open: stringList(row.open),
        latest: row.latest,
        asked: Boolean(row.asked),
      }),
    });
  return phases;
}
