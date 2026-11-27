import { randomUUID } from "node:crypto";
import { type DB, type Json, storedJson } from "@catamorphic/db";
import { type Kysely, type RawBuilder, sql, type Transaction } from "kysely";

/*
 * `session.workspace-changed` (ADR 0324): a chat's workspace was made,
 * made again, moved to another base, given back or lost with its machine.
 * Recorded as a session event, beside the session events the database
 * records for other transitions, with the same payload: the chat's
 * snapshot (`payload.session.key` included) and what changed in `detail`.
 * Workflows react to it without the turn waiting for them.
 */

export const WORKSPACE_CHANGED_EVENT = "session.workspace-changed";

/**
 * `session.workspace-setup` (ADR 0355): a chat's workspace is being set
 * up. Unlike a change, the turn waits for the runs this event starts.
 */
export const WORKSPACE_SETUP_EVENT = "session.workspace-setup";

/** What happened to the workspace. */
export type WorkspaceChange =
  | "ready"
  | "rebuilt"
  | "moved"
  | "released"
  | "lost";

/**
 * Why: `created` (its first workspace), `idle-release`, `machine-lost` or
 * `replaced` for one made again, `reset` or `rebase` for a move, `idle`,
 * `closed` or `connection-ended` for one given back, `machine-lost`.
 */
export type WorkspaceChangeReason =
  | "created"
  | "idle-release"
  | "machine-lost"
  | "replaced"
  | "reset"
  | "rebase"
  | "idle"
  | "closed"
  | "connection-ended";

/** Record one change of a chat's workspace, in `db`'s transaction if any. */
export async function recordWorkspaceChange(input: {
  db: Kysely<DB> | Transaction<DB>;
  sessionId: string;
  change: WorkspaceChange;
  reason: WorkspaceChangeReason;
}): Promise<void> {
  await recordSessionEvent({
    db: input.db,
    sessionId: input.sessionId,
    kind: WORKSPACE_CHANGED_EVENT,
    detail: sql<Json>`jsonb_build_object(
      'change', ${input.change}::text,
      'reason', ${input.reason}::text,
      'workspace', CASE WHEN jsonb_typeof(session.workspace) = 'object'
        THEN jsonb_build_object('ref', session.workspace->'ref', 'commit', session.workspace->'commit')
        ELSE 'null'::jsonb END,
      'generation', session.workspace_generation)`,
  });
}

/**
 * Record a session event the host states (ADRs 0324, 0333): the chat's
 * snapshot as every session event carries it (`payload.session.key`
 * included), Work as its actor, and `detail`, an expression that may read
 * the session's row as `session`.
 */
export async function recordSessionEvent(input: {
  db: Kysely<DB> | Transaction<DB>;
  sessionId: string;
  kind: string;
  detail: RawBuilder<Json>;
}): Promise<void> {
  // Built, not raw: a host's schema applies to every table named here.
  await input.db
    .insertInto("project_events")
    .columns([
      "project_id",
      "source",
      "kind",
      "external_id",
      "occurred_at",
      "payload",
    ])
    .expression((eb) =>
      eb
        .selectFrom("agent_sessions as session")
        .where("session.id", "=", input.sessionId)
        .select([
          "session.project_id",
          sql<string>`${"session"}::text`.as("source"),
          sql<string>`${input.kind}::text`.as("kind"),
          sql<string>`${randomUUID()}::text`.as("external_id"),
          sql<Date>`now()`.as("occurred_at"),
          sql<Json>`jsonb_build_object(
            'sessionId', session.id, 'agentId', session.agent_id,
            'externalUserId', session.external_user_id,
            'session', jsonb_build_object('id', session.id, 'key', session.chat_key,
              'title', session.title,
              'status', session.status, 'workStatus', session.work_status,
              'activity', session.activity, 'parentSessionId', session.parent_session_id,
              'stateRevision', session.state_revision, 'authorityHostId', session.authority_host_id,
              'authorityRevision', session.authority_revision),
            'actor', jsonb_build_object('kind', 'system', 'code', ${input.kind}::text),
            'causation', '[]'::jsonb,
            'detail', ${input.detail})`.as("payload"),
        ]),
    )
    .execute();
}

/** The chat as a session event describes it (`payload` less `detail`). */
export interface SessionEventSnapshot {
  projectId: string;
  snapshot: { [key: string]: Json };
}

/**
 * The chat's part of a session event the host builds before it records it
 * (ADRs 0352, 0355), so who listens can be asked of exactly what will be
 * stored: the same fields, under the same names, as the session events the
 * database and {@link recordSessionEvent} write. Read in `db`'s
 * transaction if any.
 */
export async function sessionEventSnapshot(input: {
  db: Kysely<DB> | Transaction<DB>;
  sessionId: string;
  kind: string;
}): Promise<SessionEventSnapshot> {
  const session = await input.db
    .selectFrom("agent_sessions")
    .select([
      "id",
      "project_id",
      "agent_id",
      "external_user_id",
      "chat_key",
      "title",
      "status",
      "work_status",
      "activity",
      "parent_session_id",
      "state_revision",
      "authority_host_id",
      "authority_revision",
    ])
    .where("id", "=", input.sessionId)
    .executeTakeFirstOrThrow();
  return {
    projectId: session.project_id,
    snapshot: {
      sessionId: session.id,
      agentId: session.agent_id,
      externalUserId: session.external_user_id,
      session: {
        id: session.id,
        key: session.chat_key,
        title: session.title,
        status: session.status,
        workStatus: session.work_status,
        activity: session.activity,
        parentSessionId: session.parent_session_id,
        stateRevision: Number(session.state_revision),
        authorityHostId: session.authority_host_id,
        authorityRevision: Number(session.authority_revision),
      },
      actor: { kind: "system", code: input.kind },
      causation: [],
    },
  };
}

/** A session event the host built and has not recorded yet. */
export interface PendingSessionEvent {
  id: string;
  projectId: string;
  /** The chat it is about, and whose it is: what decides who may hear it. */
  session: { id: string; externalUserId: string; agentId: string | null };
  kind: string;
  externalId: string;
  occurredAt: string;
  payload: Json;
}

/**
 * Build one session event of `kind` for a chat, with `detail` (ADRs 0352,
 * 0355). Nothing is recorded: the same payload is asked of who listens,
 * then stored.
 */
export async function pendingSessionEvent(input: {
  db: Kysely<DB> | Transaction<DB>;
  sessionId: string;
  kind: string;
  detail: { [key: string]: Json };
}): Promise<PendingSessionEvent> {
  const chat = await sessionEventSnapshot(input);
  const owner = chat.snapshot.externalUserId;
  const agent = chat.snapshot.agentId;
  return {
    id: randomUUID(),
    projectId: chat.projectId,
    session: {
      id: input.sessionId,
      externalUserId: typeof owner === "string" ? owner : "",
      agentId: typeof agent === "string" ? agent : null,
    },
    kind: input.kind,
    externalId: randomUUID(),
    occurredAt: new Date().toISOString(),
    // As jsonb gives it back, so what is matched is what is stored.
    payload: storedJson({ ...chat.snapshot, detail: input.detail }),
  };
}

/**
 * A session event as a bound workflow receives it: the envelope every
 * Project Event is dispatched in. Its sequence is the database's to give,
 * so a prospective one says 0.
 */
export function sessionEventInput(event: {
  id: string;
  projectId: string;
  kind: string;
  externalId: string;
  occurredAt: string;
  payload: Json;
}): Json {
  return {
    id: event.id,
    sequence: 0,
    projectId: event.projectId,
    source: "session",
    kind: event.kind,
    externalId: event.externalId,
    occurredAt: event.occurredAt,
    receivedAt: event.occurredAt,
    payload: event.payload,
  };
}

/**
 * Forget a chat's workspace because it went away (ADR 0324): what the
 * next one is made again after, and the event saying so.
 */
export async function recordWorkspaceGone(input: {
  db: Kysely<DB> | Transaction<DB>;
  sessionId: string;
  change: "released" | "lost";
  reason: Extract<
    WorkspaceChangeReason,
    "idle" | "closed" | "connection-ended" | "machine-lost" | "replaced"
  >;
}): Promise<void> {
  await input.db
    .updateTable("agent_sessions")
    .set({
      workspace_released_reason:
        input.reason === "idle" ? "idle-release" : input.reason,
    })
    .where("id", "=", input.sessionId)
    .execute();
  await recordWorkspaceChange(input);
}

/**
 * Count a new workspace for the chat and say so: `ready` for its first,
 * `rebuilt` after, with why the one before went away.
 */
export async function recordWorkspaceMade(input: {
  db: Kysely<DB> | Transaction<DB>;
  sessionId: string;
}): Promise<void> {
  const before = await input.db
    .selectFrom("agent_sessions")
    .select("workspace_released_reason")
    .where("id", "=", input.sessionId)
    .executeTakeFirst();
  if (!before) return;
  const row = await input.db
    .updateTable("agent_sessions")
    .set((eb) => ({
      workspace_generation: eb("workspace_generation", "+", 1),
      workspace_released_reason: null,
    }))
    .where("id", "=", input.sessionId)
    .returning(["workspace_generation"])
    .executeTakeFirstOrThrow();
  const first = row.workspace_generation <= 1;
  await recordWorkspaceChange({
    db: input.db,
    sessionId: input.sessionId,
    change: first ? "ready" : "rebuilt",
    reason: first
      ? "created"
      : madeAgainBecause(before.workspace_released_reason),
  });
}

function madeAgainBecause(value: string | null): WorkspaceChangeReason {
  return value === "idle-release" || value === "machine-lost"
    ? value
    : "replaced";
}
