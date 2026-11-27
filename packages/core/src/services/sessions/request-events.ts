import { randomUUID } from "node:crypto";
import type { RuntimeRequest } from "@catamorphic/agent-protocol";
import { type DB, type Json, storedJson } from "@catamorphic/db";
import type { Kysely, Transaction } from "kysely";
import { toJson } from "../run-coordinator.js";
import {
  type SessionEventSnapshot,
  sessionEventInput,
  sessionEventSnapshot,
} from "../workspace-events.js";

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
export type RequestEventSession = SessionEventSnapshot;

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
  return sessionEventSnapshot({ db, sessionId, kind: REQUEST_OPENED_EVENT });
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
  return sessionEventInput({ ...event, kind: REQUEST_OPENED_EVENT });
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
