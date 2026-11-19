import type { DB, Json } from "@catamorphic/db";
import { jsonbText } from "@catamorphic/db";
import { type Kysely, sql, type Transaction } from "kysely";
import { recordSessionEvent } from "../workspace-events.js";

/*
 * Progress, stalls and restarts of a running turn (ADR 0333). An attempt
 * records when it last made progress (`progress_at`: a runner frame other
 * than a diagnostic, or a model request the gateway admitted); one silent
 * longer than its agent's threshold is recorded once as stalled, with a
 * `session.turn-stalled` session event. Work only reports it.
 */

export const TURN_STALLED_EVENT = "session.turn-stalled";

type Executor = Kysely<DB> | Transaction<DB>;

/** What an attempt reported as still running: its open tool calls and commands. */
export interface ReportedActivity {
  tools: Array<{ name: string; description: string | null; since: string }>;
  commands: Array<{
    command: string;
    description: string | null;
    since: string;
  }>;
}

/** A running turn's progress, as inspect and the stall event carry it. */
export interface TurnProgress {
  id: string;
  ordinal: number;
  status: "preparing" | "running" | "waiting" | "finalizing";
  attempt: {
    id: string;
    ordinal: number;
    reason: string;
    startedAt: string | null;
  } | null;
  /** Attempts the turn made so far, this one included. */
  attempts: number;
  /** Of them, the ones that ran because someone restarted the one before. */
  restarts: number;
  /** When the attempt last made progress; null before its runner started. */
  progressAt: string | null;
  /** When the current silence was recorded as a stall; null when none. */
  stalledAt: string | null;
  /** The attempt's stall threshold; null when its agent sets none. */
  stallMinutes: number | null;
  activity: ReportedActivity;
}

const ACTIVE = ["preparing", "running", "waiting", "finalizing"] as const;

function iso(value: Date | string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

/** The open tool calls and commands an attempt reported. */
export async function reportedActivity(
  db: Executor,
  attemptId: string,
): Promise<ReportedActivity> {
  const rows = await db
    .selectFrom("agent_items")
    .select(["kind", "payload", "created_at"])
    .where("attempt_id", "=", attemptId)
    .where("status", "=", "in_progress")
    .where("kind", "in", ["tool_call", "command"])
    .orderBy("position")
    .limit(20)
    .execute();
  const activity: ReportedActivity = { tools: [], commands: [] };
  for (const row of rows) {
    const payload = (row.payload ?? {}) as Record<string, unknown>;
    const since =
      typeof payload.startedAt === "string"
        ? payload.startedAt
        : row.created_at.toISOString();
    const description =
      typeof payload.description === "string" ? payload.description : null;
    if (row.kind === "tool_call")
      activity.tools.push({
        name: typeof payload.tool === "string" ? payload.tool : "",
        description,
        since,
      });
    else
      activity.commands.push({
        command:
          typeof payload.command === "string"
            ? payload.command.slice(0, 2_000)
            : "",
        description,
        since,
      });
  }
  return activity;
}

/** The session's active turn and its progress, or null when none works. */
export async function turnProgress(
  db: Executor,
  sessionId: string,
): Promise<TurnProgress | null> {
  const turn = await db
    .selectFrom("agent_turns")
    .select(["id", "ordinal", "status", "active_attempt_id"])
    .where("session_id", "=", sessionId)
    .where("status", "in", [...ACTIVE])
    .executeTakeFirst();
  if (!turn) return null;
  const attempts = await db
    .selectFrom("agent_turn_attempts")
    .select([
      "id",
      "ordinal",
      "reason",
      "started_at",
      "progress_at",
      "stalled_at",
      "stall_after_seconds",
    ])
    .where("turn_id", "=", turn.id)
    .orderBy("ordinal")
    .execute();
  const attempt = attempts.find((row) => row.id === turn.active_attempt_id);
  const status = ACTIVE.find((value) => value === turn.status) ?? "running";
  return {
    id: turn.id,
    ordinal: turn.ordinal,
    status,
    attempt: attempt
      ? {
          id: attempt.id,
          ordinal: attempt.ordinal,
          reason: attempt.reason,
          startedAt: iso(attempt.started_at),
        }
      : null,
    attempts: attempts.length,
    restarts: attempts.filter((row) => row.reason === "restart").length,
    progressAt: attempt ? iso(attempt.progress_at) : null,
    stalledAt: attempt ? iso(attempt.stalled_at) : null,
    stallMinutes:
      attempt?.stall_after_seconds != null
        ? attempt.stall_after_seconds / 60
        : null,
    activity: attempt
      ? await reportedActivity(db, attempt.id)
      : { tools: [], commands: [] },
  };
}

/**
 * Record every stall that fell due by `at` on chats this host holds, once
 * per silence, each with its `session.turn-stalled` event in the same
 * transaction. An attempt waiting on a person is not stalled: that wait
 * is theirs. Nor is one whose subsessions, at any depth, made progress
 * within its threshold: a coordinator waits while they work. One query
 * finds them all. Returns how many it recorded.
 */
export async function recordStalls(input: {
  db: Kysely<DB>;
  hostIds: readonly string[];
  at?: Date;
}): Promise<number> {
  const at = input.at ?? new Date();
  return input.db.transaction().execute(async (trx) => {
    // Silent by its own clock, as an attempt must be to stall.
    const silent = sql<Date>`${at}::timestamptz - make_interval(secs => attempt.stall_after_seconds)`;
    const stalled = await trx
      // Each candidate's session family: the candidate's session and its
      // subsessions at every depth (ADR 0322). A coordinator waiting on
      // subagents that work is not stalled. UNION ends a cycle.
      .withRecursive("stall_family(root_id, session_id)", (db) =>
        db
          .selectFrom("agent_turn_attempts as attempt")
          .innerJoin(
            "agent_turns as turn",
            "turn.active_attempt_id",
            "attempt.id",
          )
          .innerJoin(
            "agent_sessions as session",
            "session.id",
            "turn.session_id",
          )
          .select([
            "attempt.session_id as root_id",
            "attempt.session_id as session_id",
          ])
          .where("turn.status", "=", "running")
          .where("attempt.status", "=", "running")
          .where("attempt.stall_after_seconds", "is not", null)
          .where("attempt.stalled_at", "is", null)
          .where("attempt.progress_at", "<=", silent)
          .where("session.authority_host_id", "in", [...input.hostIds])
          .union((qb) =>
            qb
              .selectFrom("stall_family as family")
              .innerJoin(
                "agent_sessions as child",
                "child.parent_session_id",
                "family.session_id",
              )
              .select(["family.root_id as root_id", "child.id as session_id"]),
          ),
      )
      .updateTable("agent_turn_attempts as attempt")
      .from("agent_turns as turn")
      .innerJoin("agent_sessions as session", "session.id", "turn.session_id")
      .set({ stalled_at: at })
      .whereRef("turn.id", "=", "attempt.turn_id")
      .whereRef("turn.active_attempt_id", "=", "attempt.id")
      .where("turn.status", "=", "running")
      .where("attempt.status", "=", "running")
      .where("attempt.stall_after_seconds", "is not", null)
      .where("attempt.stalled_at", "is", null)
      .where("attempt.progress_at", "is not", null)
      .where("attempt.progress_at", "<=", silent)
      .where("session.authority_host_id", "in", [...input.hostIds])
      // ...and no subsession's working turn made progress within the
      // threshold either.
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom("stall_family as family")
              .innerJoin(
                "agent_turns as child_turn",
                "child_turn.session_id",
                "family.session_id",
              )
              .innerJoin(
                "agent_turn_attempts as child_attempt",
                "child_attempt.id",
                "child_turn.active_attempt_id",
              )
              .select("child_attempt.id")
              .whereRef("family.root_id", "=", "attempt.session_id")
              .whereRef("family.session_id", "!=", "family.root_id")
              .where("child_turn.status", "in", [...ACTIVE])
              .where("child_attempt.progress_at", ">", silent),
          ),
        ),
      )
      .returning([
        "attempt.id as attemptId",
        "attempt.turn_id as turnId",
        "attempt.session_id as sessionId",
        "attempt.ordinal as ordinal",
        "attempt.progress_at as progressAt",
        "attempt.stall_after_seconds as stallAfterSeconds",
      ])
      .execute();
    for (const row of stalled) {
      const progress = await turnProgress(trx, row.sessionId);
      const detail = {
        turnId: row.turnId,
        attemptId: row.attemptId,
        attempt: row.ordinal,
        attempts: progress?.attempts ?? row.ordinal,
        restarts: progress?.restarts ?? 0,
        progressAt: iso(row.progressAt),
        stalledAt: at.toISOString(),
        stallMinutes: (row.stallAfterSeconds ?? 0) / 60,
        activity: progress?.activity ?? { tools: [], commands: [] },
      };
      await recordSessionEvent({
        db: trx,
        sessionId: row.sessionId,
        kind: TURN_STALLED_EVENT,
        detail: sql<Json>`${jsonbText(detail)}::jsonb`,
      });
    }
    return stalled.length;
  });
}

/** When the next stall on chats this host holds falls due, if any. */
export async function nextStallAt(input: {
  db: Kysely<DB>;
  hostIds: readonly string[];
}): Promise<Date | null> {
  const row = await input.db
    .selectFrom("agent_turn_attempts as attempt")
    .innerJoin("agent_sessions as session", "session.id", "attempt.session_id")
    .select(
      sql<Date | null>`min(attempt.progress_at + make_interval(secs => attempt.stall_after_seconds))`.as(
        "at",
      ),
    )
    .where("attempt.status", "=", "running")
    .where("attempt.stall_after_seconds", "is not", null)
    .where("attempt.stalled_at", "is", null)
    // One already due but held off by its subsessions' progress is checked
    // on the worker's regular polls, never in a busy loop.
    .where(
      sql<Date>`attempt.progress_at + make_interval(secs => attempt.stall_after_seconds)`,
      ">",
      sql<Date>`now()`,
    )
    .where("session.authority_host_id", "in", [...input.hostIds])
    .executeTakeFirst();
  return row?.at ? new Date(row.at) : null;
}

/** A turn's attempts as `attempts` reads them, with their diagnostics. */
export interface AttemptRecord {
  id: string;
  ordinal: number;
  reason: string;
  status: string;
  error: { message: string } | null;
  startedAt: string | null;
  completedAt: string | null;
  progressAt: string | null;
  stalledAt: string | null;
  /** The masked tails of the runner's and the harness's own output. */
  diagnostics: { runner: string; harness: string } | null;
}

export async function attemptRecords(
  db: Executor,
  input: { sessionId: string; turnId: string },
): Promise<AttemptRecord[]> {
  const rows = await db
    .selectFrom("agent_turn_attempts")
    .select([
      "id",
      "ordinal",
      "reason",
      "status",
      "error",
      "started_at",
      "completed_at",
      "progress_at",
      "stalled_at",
      "diagnostics",
    ])
    .where("session_id", "=", input.sessionId)
    .where("turn_id", "=", input.turnId)
    .orderBy("ordinal")
    .execute();
  return rows.map((row) => {
    const error = row.error as { message?: unknown } | null;
    const diagnostics = row.diagnostics as {
      runner?: unknown;
      harness?: unknown;
    } | null;
    return {
      id: row.id,
      ordinal: row.ordinal,
      reason: row.reason,
      status: row.status,
      error:
        error && typeof error.message === "string"
          ? { message: error.message }
          : null,
      startedAt: iso(row.started_at),
      completedAt: iso(row.completed_at),
      progressAt: iso(row.progress_at),
      stalledAt: iso(row.stalled_at),
      diagnostics: diagnostics
        ? {
            runner:
              typeof diagnostics.runner === "string" ? diagnostics.runner : "",
            harness:
              typeof diagnostics.harness === "string"
                ? diagnostics.harness
                : "",
          }
        : null,
    };
  });
}

/** Model traffic on an attempt's grant is progress (ADR 0333), once a second at most. */
export async function touchProgress(input: {
  db: Executor;
  attemptId: string;
}): Promise<void> {
  await input.db
    .updateTable("agent_turn_attempts")
    .set({ progress_at: sql<Date>`now()`, stalled_at: null })
    .where("id", "=", input.attemptId)
    .where("status", "in", ["preparing", "running"])
    .where((eb) =>
      eb.or([
        eb("progress_at", "is", null),
        eb("progress_at", "<", sql<Date>`now() - interval '1 second'`),
        eb("stalled_at", "is not", null),
      ]),
    )
    .execute();
}
