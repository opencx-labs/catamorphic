import { randomUUID } from "node:crypto";
import type { RuntimeRequest } from "@catamorphic/agent-protocol";
import { type DB, type Json, storedJson } from "@catamorphic/db";
import type { Kysely, Transaction } from "kysely";
import { toJson } from "../run-coordinator.js";

/*
 * `session.request-opened` (ADR 0352): an agent asked for something its
 * turn waits on, an approval, a question or an elicitation. Recorded as a
 * session event in the transaction that opens the request, with the chat's
 * snapshot as every session event carries it (`payload.session.key`
 * included) and the request in `detail`. A workflow answers with the
 * ordinary `answer` session operation; a project automation that listens
 * is what lets an unattended chat's approval wait instead of being refused
 * at once.
 */

export const REQUEST_OPENED_EVENT = "session.request-opened";

type Executor = Kysely<DB> | Transaction<DB>;

/** The chat as a session event describes it, read once per batch. */
export interface RequestEventSession {
  projectId: string;
  snapshot: { [key: string]: Json };
}

/** One request's event: the row to record, and what a workflow receives. */
export interface RequestOpenedEvent {
  id: string;
  projectId: string;
  externalId: string;
  occurredAt: string;
  payload: Json;
}

/**
 * Whether a project automation subscribes to this event (its trigger's
 * config and `where` matched as a dispatch matches them), read in the
 * caller's transaction.
 */
export type RequestListeners = (input: {
  executor: Executor;
  projectId: string;
  /** The event as a bound workflow would receive it. */
  event: Json;
}) => Promise<boolean>;

/** The chat's part of a request event, in `db`'s transaction if any. */
export async function requestEventSession(
  db: Executor,
  sessionId: string,
): Promise<RequestEventSession> {
  const session = await db
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
    .where("id", "=", sessionId)
    .executeTakeFirstOrThrow();
  return {
    projectId: session.project_id,
    // The same fields, under the same names, as the session events the
    // database and `recordSessionEvent` write.
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
      actor: { kind: "system", code: REQUEST_OPENED_EVENT },
      causation: [],
    },
  };
}

/** The event of one request that opened in `session`. */
export function requestOpenedEvent(
  session: RequestEventSession,
  request: RuntimeRequest,
): RequestOpenedEvent {
  return {
    id: randomUUID(),
    projectId: session.projectId,
    externalId: randomUUID(),
    occurredAt: request.createdAt,
    // As jsonb gives it back, so what is matched is what is stored.
    payload: storedJson(
      toJson({
        ...session.snapshot,
        detail: {
          requestId: request.id,
          kind: request.kind,
          blocking: request.blocking,
          title: request.title,
          description: request.description,
          origin: { ...request.origin },
          approval: request.approval,
          questions: request.questions,
          elicitation: request.elicitation,
          turnId: request.turnId,
          attemptId: request.attemptId,
          expiresAt: request.expiresAt,
        },
      }),
    ),
  };
}

/**
 * The event as a bound workflow receives it: the envelope every Project
 * Event is dispatched in. Its sequence is the database's to give, so a
 * prospective one says 0.
 */
export function requestEventInput(event: RequestOpenedEvent): Json {
  return {
    id: event.id,
    sequence: 0,
    projectId: event.projectId,
    source: "session",
    kind: REQUEST_OPENED_EVENT,
    externalId: event.externalId,
    occurredAt: event.occurredAt,
    receivedAt: event.occurredAt,
    payload: event.payload,
  };
}

/** Record the events of requests that opened, in `db`'s transaction if any. */
export async function recordRequestsOpened(
  db: Executor,
  events: readonly RequestOpenedEvent[],
): Promise<void> {
  if (events.length === 0) return;
  await db
    .insertInto("project_events")
    .values(
      events.map((event) => ({
        id: event.id,
        project_id: event.projectId,
        source: "session",
        kind: REQUEST_OPENED_EVENT,
        external_id: event.externalId,
        occurred_at: new Date(event.occurredAt),
        payload: event.payload,
      })),
    )
    .execute();
}
