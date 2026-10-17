import {
  type AgentEffort,
  type AgentTodo,
  type Attempt,
  type AttemptReason,
  type AttemptStatus,
  type ImportedSession,
  type Item,
  isImportedHarness,
  type JsonValue,
  type NativeRef,
  type ProviderThread,
  type RuntimeRequest,
  type SessionFields,
  type SessionMetadata,
  type Turn,
  type TurnError,
  type TurnOutcome,
  type TurnStatus,
} from "@catamorphic/agent-protocol";
import type { DB, Json } from "@catamorphic/db";
import type { Kysely, Selectable, Transaction } from "kysely";

/**
 * Projection rows to protocol entities (ADR 0197). The projections are
 * written only by the session log's projector, so these mappers are the
 * one place their shape is read.
 */

export type SessionRow = Selectable<DB["agent_sessions"]>;
export type TurnRow = Selectable<DB["agent_turns"]>;
export type AttemptRow = Selectable<DB["agent_turn_attempts"]>;
export type ItemRow = Selectable<DB["agent_items"]>;
export type RequestRow = Selectable<DB["agent_runtime_requests"]>;
export type ProviderThreadRow = Selectable<DB["agent_provider_threads"]>;

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

/** A JSON column read back as the shape the projector wrote into it. */
function stored<T>(value: Json | null | undefined): T | null {
  return value === null || value === undefined ? null : (value as unknown as T);
}

const TURN_STATUSES: readonly TurnStatus[] = [
  "queued",
  "held",
  "preparing",
  "running",
  "waiting",
  "finalizing",
  "completed",
  "failed",
  "interrupted",
  "cancelled",
  "rolled_back",
];

export function turnStatus(value: string): TurnStatus {
  const status = TURN_STATUSES.find((candidate) => candidate === value);
  if (!status) throw new Error(`Invalid persisted turn status '${value}'`);
  return status;
}

export function turnFromRow(row: TurnRow): Turn {
  return {
    id: row.id,
    sessionId: row.session_id,
    ordinal: row.ordinal,
    status: turnStatus(row.status),
    inputItemId: row.input_item_id,
    dispatch: row.dispatch === "interrupt" ? "interrupt" : "queue",
    priority: row.priority,
    activity: row.activity,
    activityAt: iso(row.activity_at),
    attemptCount: row.attempt_count,
    activeAttemptId: row.active_attempt_id,
    providerThreadId: row.provider_thread_id,
    retryAt:
      row.status === "queued" &&
      row.attempt_count > 0 &&
      row.available_at > new Date()
        ? row.available_at.toISOString()
        : null,
    cancellationRequested: row.cancellation_requested_at !== null,
    error: stored<TurnError>(row.error),
    outcome: stored<TurnOutcome>(row.outcome),
    checkpoint: {
      before: row.checkpoint_before?.trim() ?? null,
      after: row.checkpoint_after?.trim() ?? null,
    },
    continuationOf: row.continuation_of,
    createdAt: row.created_at.toISOString(),
    startedAt: iso(row.started_at),
    completedAt: iso(row.completed_at),
    updatedAt: row.updated_at.toISOString(),
  };
}

const ATTEMPT_REASONS: readonly AttemptReason[] = [
  "initial",
  "retry",
  "steer_restart",
  "recovery",
];
const ATTEMPT_STATUSES: readonly AttemptStatus[] = [
  "preparing",
  "running",
  "completed",
  "failed",
  "interrupted",
  "lost",
  "superseded",
];

export function attemptFromRow(row: AttemptRow): Attempt {
  const reason = ATTEMPT_REASONS.find((value) => value === row.reason);
  const status = ATTEMPT_STATUSES.find((value) => value === row.status);
  if (!reason || !status)
    throw new Error(`Invalid persisted attempt ${row.id}`);
  return {
    id: row.id,
    turnId: row.turn_id,
    sessionId: row.session_id,
    ordinal: row.ordinal,
    reason,
    status,
    providerThreadId: row.provider_thread_id,
    nativeTurnRef: stored<NativeRef>(row.native_turn_ref),
    error: stored<TurnError>(row.error),
    createdAt: row.created_at.toISOString(),
    startedAt: iso(row.started_at),
    completedAt: iso(row.completed_at),
  };
}

/** An item row holds the whole protocol item in `payload`. */
export function itemFromRow(row: Pick<ItemRow, "payload">): Item {
  const item = stored<Item>(row.payload);
  if (!item) throw new Error("An item row has no payload");
  return item;
}

export function requestFromRow(row: RequestRow): RuntimeRequest {
  const payload = stored<RuntimeRequest>(row.payload);
  if (!payload || typeof payload !== "object")
    throw new Error(`Runtime request ${row.request_id} has no payload`);
  return {
    ...payload,
    id: row.request_id,
    sessionId: row.session_id,
    turnId: row.turn_id,
    attemptId: row.attempt_id,
    itemId: row.item_id,
    status:
      row.status === "resolved" ||
      row.status === "expired" ||
      row.status === "cancelled"
        ? row.status
        : "pending",
    answerable: row.answerable && row.status === "pending",
    blocking: row.blocking,
    expiresAt: iso(row.expires_at),
    response: stored(row.response),
    resolvedBy: row.resolved_by_external_user_id,
    reason: row.reason,
    createdAt: row.created_at.toISOString(),
    resolvedAt: iso(row.resolved_at),
  };
}

export function providerThreadFromRow(row: ProviderThreadRow): ProviderThread {
  return {
    id: row.id,
    sessionId: row.session_id,
    harness: row.harness,
    nativeRef: stored<NativeRef>(row.native_ref),
    status:
      row.status === "unavailable" || row.status === "closed"
        ? row.status
        : "active",
    lastTurnOrdinal: row.last_turn_ordinal,
    portable: row.portable,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

const EFFORTS: readonly AgentEffort[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export function sessionFieldsFromRow(row: SessionRow): SessionFields {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    icon: row.icon,
    agentId: row.agent_id,
    harness: row.harness,
    model: row.model,
    modelEffort: EFFORTS.find((effort) => effort === row.model_effort) ?? null,
    status: row.status === "closed" ? "closed" : "active",
    workStatus: row.work_status === "completed" ? "completed" : "open",
    activity: row.activity,
    todos: Array.isArray(row.todos)
      ? (row.todos as unknown as AgentTodo[])
      : [],
    metadata: sessionMetadataFromRow(row.metadata),
    imported: importedSessionFromRow(row.imported),
    parentSessionId: row.parent_session_id,
    forkedFromSessionId: row.forked_from_session_id,
    attentionRevision: Number(row.attention_revision),
    environment: row.environment_name,
    authorityHostId: row.authority_host_id,
    authorityRevision: Number(row.authority_revision),
    handoffStatus: row.handoff_status === "pending" ? "pending" : "none",
    updatedAt: row.updated_at.toISOString(),
  };
}

/** The imported column (ADR 0233): where another tool's session came from. */
export function importedSessionFromRow(
  value: Json | null,
): ImportedSession | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const {
    harness,
    nativeSessionId,
    sourcePath,
    contentSha256,
    sourceModifiedAt,
  } = value;
  if (
    !isImportedHarness(harness) ||
    typeof nativeSessionId !== "string" ||
    typeof sourcePath !== "string" ||
    typeof contentSha256 !== "string" ||
    typeof sourceModifiedAt !== "string"
  )
    return null;
  return {
    harness,
    nativeSessionId,
    sourcePath,
    contentSha256,
    sourceModifiedAt,
  };
}

/** The metadata column (ADR 0226): an object, as its constraint keeps it. */
export function sessionMetadataFromRow(value: Json): SessionMetadata {
  const metadata = protocolJsonValue(value);
  return typeof metadata === "object" &&
    metadata !== null &&
    !Array.isArray(metadata)
    ? metadata
    : {};
}

/**
 * A stored JSON value in the protocol's terms: an object member read back
 * as undefined is left out, as JSON text leaves it out. Members are defined,
 * never assigned, so a nested `__proto__` key stays a key.
 */
function protocolJsonValue(value: Json): JsonValue {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(protocolJsonValue);
  return Object.fromEntries(
    Object.entries(value).flatMap(
      ([key, member]): Array<[string, JsonValue]> =>
        member === undefined ? [] : [[key, protocolJsonValue(member)]],
    ),
  );
}

/**
 * The turn waiting to take in task notifications (ADR 0217): queued, never
 * started, and started by one. A later notification joins it instead of
 * queueing a turn of its own, so the agent reads them together.
 */
export async function waitingNotificationTurn(
  executor: Kysely<DB> | Transaction<DB>,
  sessionId: string,
): Promise<Turn | null> {
  const [first] = await waitingNotificationTurns(executor, sessionId, 1);
  return first ?? null;
}

/**
 * Every turn waiting to take in task notifications, in order: one, unless
 * some notifications were the owner's and some not (ADR 0199). The next
 * turn to start takes them in instead (ADR 0240).
 */
export async function waitingNotificationTurns(
  executor: Kysely<DB> | Transaction<DB>,
  sessionId: string,
  limit = 20,
): Promise<Turn[]> {
  const rows = await executor
    .selectFrom("agent_turns as turn")
    .innerJoin("agent_items as item", "item.id", "turn.input_item_id")
    .selectAll("turn")
    .where("turn.session_id", "=", sessionId)
    .where("turn.status", "=", "queued")
    .where("turn.attempt_count", "=", 0)
    .where("item.kind", "=", "task_notification")
    .orderBy("turn.ordinal")
    .limit(limit)
    .execute();
  return rows.map(turnFromRow);
}
