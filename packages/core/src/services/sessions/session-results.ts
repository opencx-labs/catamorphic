import { randomUUID } from "node:crypto";
import {
  INPUT_ITEM_KINDS,
  type InputItem,
  type JsonValue,
  type ResultItem,
} from "@catamorphic/agent-protocol";
import type { DB, Json } from "@catamorphic/db";
import { type Kysely, sql, type Transaction } from "kysely";
import { RESULT_LIMITS } from "../agent-results.js";
import type { SessionLog } from "./session-log.js";
import { itemFromRow } from "./session-rows.js";

/*
 * Typed results in the session log (ADR 0323): what `submit_result`
 * records, and what readers (workflows, the project MCP, REST, a parent
 * agent) read back. A result is an item, so it is ordered, mirrored and
 * forked with the chat, and it is never rewritten.
 */

type Executor = Kysely<DB> | Transaction<DB>;

/** An input as a result names it: the item, its place and its kind. */
export interface ResultInput {
  itemId: string;
  position: number;
  /** `user_message`, `inbound_message` or `task_notification`. */
  kind: InputItem["kind"];
}

/** One recorded result, as readers see it. */
export interface SessionResult {
  id: string;
  /** The chat that recorded it: the named one, or one of its subsessions. */
  sessionId: string;
  turnId: string | null;
  attemptId: string | null;
  name: string;
  value: JsonValue;
  /** The newest input the chat had taken in when the agent submitted it. */
  input: ResultInput | null;
  /**
   * No new request reached the chat after that input: nothing a person, a
   * workflow or a session outside the chat's own subsessions sent since.
   */
  current: boolean;
  commit: string | null;
  recordedAt: string;
}

/** `afterInput` named no input of the chat. */
export class SessionInputNotFoundError extends Error {
  constructor(readonly itemId: string) {
    super("No input in this chat has that id");
    this.name = "SessionInputNotFoundError";
  }
}

/** The submitting attempt no longer runs its turn: a takeover, or the turn ended. */
export class SessionResultAttemptError extends Error {
  constructor() {
    super(
      "This attempt no longer runs its turn, so its result does not count.",
    );
    this.name = "SessionResultAttemptError";
  }
}

export class SessionResultLimitError extends Error {
  constructor() {
    super(
      `This chat has recorded ${RESULT_LIMITS.perSession} results, the most one chat keeps`,
    );
    this.name = "SessionResultLimitError";
  }
}

const INPUT_KINDS = [...INPUT_ITEM_KINDS];

/** Statuses of a turn whose attempt may still submit: it is working. */
const SUBMITTING_TURN_STATUSES = ["running", "waiting"];

/** Statuses of a turn whose input the agent has not taken in. */
const UNSTARTED = ["queued", "held", "cancelled"];

/**
 * The newest input the agent has taken in: read (not an unread steer or an
 * undelivered context message) and not waiting for a turn of its own.
 */
async function consumedInput(
  db: Executor,
  input: { sessionId: string; turnId: string },
): Promise<ResultInput | null> {
  const row = await db
    .selectFrom("agent_items as item")
    .leftJoin("agent_turns as turn", "turn.id", "item.turn_id")
    .select(["item.id", "item.position", "item.kind"])
    .where("item.session_id", "=", input.sessionId)
    .where("item.kind", "in", INPUT_KINDS)
    .where("item.status", "=", "completed")
    .where((eb) =>
      eb.or([
        eb("item.turn_id", "is", null),
        eb("item.turn_id", "=", input.turnId),
        eb("turn.status", "not in", UNSTARTED),
      ]),
    )
    .orderBy("item.position", "desc")
    .limit(1)
    .executeTakeFirst();
  return row
    ? {
        itemId: row.id,
        position: Number(row.position),
        kind: inputKind(row.kind),
      }
    : null;
}

function inputKind(kind: string): InputItem["kind"] {
  const known = INPUT_KINDS.find((candidate) => candidate === kind);
  if (!known) throw new Error(`Not an input kind: ${kind}`);
  return known;
}

/** Each chat with its subsessions at every depth: its own work. */
export async function ownFamilies(
  db: Executor,
  sessionIds: readonly string[],
): Promise<Map<string, Set<string>>> {
  const families = new Map(sessionIds.map((id) => [id, new Set([id])]));
  let frontier = sessionIds.map((id) => ({ root: id, id }));
  for (let depth = 0; frontier.length > 0 && depth < 32; depth++) {
    const rows = await db
      .selectFrom("agent_sessions")
      .select(["id", "parent_session_id"])
      .where(
        "parent_session_id",
        "in",
        frontier.map((entry) => entry.id),
      )
      .execute();
    const next: Array<{ root: string; id: string }> = [];
    for (const entry of frontier)
      for (const row of rows) {
        const family = families.get(entry.root);
        if (row.parent_session_id !== entry.id || !family || family.has(row.id))
          continue;
        family.add(row.id);
        next.push({ root: entry.root, id: row.id });
      }
    frontier = next;
  }
  return families;
}

/**
 * Each chat's newest new request, whether or not the agent has reached it:
 * a person's message, or words a workflow, an assistant or a session outside
 * the chat's own family sent. Task notifications, and messages its own
 * subsessions send, are the agent's own work reporting back.
 */
/**
 * A chat's requests, as a result's `current` counts them (ADR 0323): a
 * person's message, or words from a workflow or a session outside the
 * chat's own family (`own`, from {@link ownFamilies}). Task notifications
 * and its subsessions' reports are its own work; a request withdrawn
 * before it ran, or undone by a rollback, asks for nothing any more.
 * Hand-offs list the same requests (ADR 0328). Newest first.
 */
export async function readRequests(
  db: Executor,
  input: {
    sessionId: string;
    own: readonly string[];
    /** Only requests of these turns. */
    turnIds?: readonly string[];
    /** Only requests after this position. */
    after?: number;
    limit?: number;
  },
): Promise<
  Array<{ id: string; position: number; kind: string; payload: Json }>
> {
  if (input.turnIds?.length === 0) return [];
  const rows = await db
    .selectFrom("agent_items as item")
    .leftJoin("agent_turns as turn", "turn.id", "item.turn_id")
    .select(["item.id", "item.position", "item.kind", "item.payload"])
    .where("item.session_id", "=", input.sessionId)
    .where("item.kind", "in", ["user_message", "inbound_message"])
    .where((eb) =>
      eb.or([
        eb("turn.status", "is", null),
        eb("turn.status", "not in", ["cancelled", "rolled_back"]),
      ]),
    )
    .where((eb) =>
      eb.or([
        eb("item.author_kind", "is", null),
        eb("item.author_kind", "<>", "agent"),
        eb(sql<string>`item.author_payload->>'sessionId'`, "not in", [
          ...input.own,
        ]),
      ]),
    )
    .$if(input.turnIds !== undefined, (query) =>
      query.where("item.turn_id", "in", [...(input.turnIds ?? [])]),
    )
    .$if(input.after !== undefined, (query) =>
      query.where("item.position", ">", String(input.after ?? -1)),
    )
    .$if(input.limit !== undefined, (query) => query.limit(input.limit ?? 1))
    .orderBy("item.position", "desc")
    .execute();
  return rows.map((row) => ({
    id: row.id,
    position: Number(row.position),
    kind: row.kind,
    payload: row.payload,
  }));
}

async function newestRequests(
  db: Executor,
  sessionIds: readonly string[],
): Promise<Map<string, ResultInput>> {
  const newest = new Map<string, ResultInput>();
  if (sessionIds.length === 0) return newest;
  const families = await ownFamilies(db, sessionIds);
  for (const sessionId of sessionIds) {
    const own = [...(families.get(sessionId) ?? [sessionId])];
    const [row] = await readRequests(db, { sessionId, own, limit: 1 });
    if (row)
      newest.set(sessionId, {
        itemId: row.id,
        position: Number(row.position),
        kind: inputKind(row.kind),
      });
  }
  return newest;
}

/** Whether no new request reached the chat after the result's input. */
function isCurrent(
  input: ResultInput | null,
  request: ResultInput | undefined,
): boolean {
  if (request === undefined) return true;
  return input !== null && input.position >= request.position;
}

/**
 * Record an accepted result as an item of the turn that submitted it. The
 * caller has validated the value against its schema.
 */
export async function recordResult(
  trx: Transaction<DB>,
  log: SessionLog,
  input: {
    sessionId: string;
    turnId: string;
    /** The attempt whose runner submitted it: it must still run the turn. */
    attemptId: string;
    name: string;
    value: JsonValue;
  },
): Promise<ResultItem> {
  await log.lock(trx, input.sessionId);
  const count = await trx
    .selectFrom("agent_items")
    .select((eb) => eb.fn.countAll<string>().as("count"))
    .where("session_id", "=", input.sessionId)
    .where("kind", "=", "result")
    .executeTakeFirstOrThrow();
  if (Number(count.count) >= RESULT_LIMITS.perSession)
    throw new SessionResultLimitError();
  const turn = await trx
    .selectFrom("agent_turns")
    .select(["active_attempt_id", "checkpoint_before", "status"])
    .where("id", "=", input.turnId)
    .where("session_id", "=", input.sessionId)
    .executeTakeFirstOrThrow();
  // Checked under the session's lock: a call that finishes after a
  // takeover, or after its turn ended, records nothing.
  if (
    turn.active_attempt_id !== input.attemptId ||
    !SUBMITTING_TURN_STATUSES.includes(turn.status)
  )
    throw new SessionResultAttemptError();
  const now = new Date().toISOString();
  const item: ResultItem = {
    id: randomUUID(),
    sessionId: input.sessionId,
    turnId: input.turnId,
    attemptId: input.attemptId,
    parentItemId: null,
    position: 0,
    status: "completed",
    nativeRef: null,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    endedAt: now,
    kind: "result",
    name: input.name,
    value: input.value,
    input: await consumedInput(trx, input),
    commit: turn.checkpoint_before?.trim() || null,
  };
  const [stored] = await log.append(trx, {
    sessionId: input.sessionId,
    events: [{ type: "item.added", item }],
  });
  const added = stored?.event;
  return added?.type === "item.added" && added.item.kind === "result"
    ? added.item
    : item;
}

/**
 * Results of the given chats, newest first. `afterInput` keeps, of the chat
 * the input belongs to, results whose input is that one or a later one,
 * and of the others results recorded after it arrived. Results of rolled
 * back turns are left out.
 */
export async function readResults(
  db: Executor,
  input: {
    sessionIds: readonly string[];
    name?: string;
    /** Only what this turn's attempts submitted. */
    turnId?: string;
    afterInput?: { sessionId: string; position: number; createdAt: Date };
    limit: number;
  },
): Promise<SessionResult[]> {
  if (input.sessionIds.length === 0) return [];
  const after = input.afterInput;
  const rows = await db
    .selectFrom("agent_items as item")
    .leftJoin("agent_turns as turn", "turn.id", "item.turn_id")
    .select(["item.payload", "item.session_id"])
    .where("item.session_id", "in", [...input.sessionIds])
    .where("item.kind", "=", "result")
    // A result this side did not accept (a mirror's, ADR 0323) is no result.
    .where("item.status", "=", "completed")
    .where((eb) =>
      eb.or([
        eb("turn.status", "is", null),
        eb("turn.status", "<>", "rolled_back"),
      ]),
    )
    .$if(input.name !== undefined, (query) =>
      query.where(sql<string>`item.payload->>'name'`, "=", input.name ?? ""),
    )
    .$if(input.turnId !== undefined, (query) =>
      query.where("item.turn_id", "=", input.turnId ?? ""),
    )
    .$if(after !== undefined, (query) =>
      query.where((eb) =>
        eb.or([
          eb.and([
            eb("item.session_id", "=", after?.sessionId ?? ""),
            eb(
              sql<number>`(item.payload->'input'->>'position')::bigint`,
              ">=",
              after?.position ?? 0,
            ),
          ]),
          eb.and([
            eb("item.session_id", "<>", after?.sessionId ?? ""),
            eb("item.created_at", ">=", after?.createdAt ?? new Date(0)),
          ]),
        ]),
      ),
    )
    .orderBy("item.created_at", "desc")
    .orderBy("item.position", "desc")
    .limit(input.limit)
    .execute();
  const newest = await newestRequests(db, [
    ...new Set(rows.map((row) => row.session_id)),
  ]);
  return rows.flatMap((row) => {
    const item = itemFromRow(row);
    if (item.kind !== "result") return [];
    const latest = newest.get(item.sessionId);
    return [
      {
        id: item.id,
        sessionId: item.sessionId,
        turnId: item.turnId,
        attemptId: item.attemptId,
        name: item.name,
        value: item.value,
        input: item.input,
        current: isCurrent(item.input, latest),
        commit: item.commit,
        recordedAt: item.createdAt,
      },
    ];
  });
}

/** A chat and its subsessions at every depth, the chat first. */
export async function sessionFamily(
  db: Executor,
  input: { projectId: string; sessionId: string; limit?: number },
): Promise<string[]> {
  const limit = input.limit ?? 500;
  const family = [input.sessionId];
  let frontier = [input.sessionId];
  while (frontier.length > 0 && family.length < limit) {
    const rows = await db
      .selectFrom("agent_sessions")
      .select("id")
      .where("project_id", "=", input.projectId)
      .where("parent_session_id", "in", frontier)
      .orderBy("created_at")
      .limit(limit - family.length)
      .execute();
    frontier = rows.map((row) => row.id).filter((id) => !family.includes(id));
    family.push(...frontier);
  }
  return family;
}

/** A child's latest result of one name, as its parent agent reads it. */
export interface LatestResult {
  id: string;
  name: string;
  /** Null when `truncated`: the value is too large to show here. */
  value: JsonValue;
  truncated: boolean;
  current: boolean;
  turnId: string | null;
  recordedAt: string;
}

/** Above this, a parent's compact views leave the value to `results`. */
export const LATEST_RESULT_VALUE_BYTES = 8 * 1024;

/** Each chat's latest result of every name, by chat. */
export async function latestResults(
  db: Executor,
  sessionIds: readonly string[],
): Promise<Map<string, LatestResult[]>> {
  const latest = new Map<string, LatestResult[]>();
  if (sessionIds.length === 0) return latest;
  const rows = await db
    .selectFrom("agent_items as item")
    .leftJoin("agent_turns as turn", "turn.id", "item.turn_id")
    .select(["item.payload", "item.session_id"])
    .distinctOn(["item.session_id", sql`item.payload->>'name'`])
    .where("item.session_id", "in", [...sessionIds])
    .where("item.kind", "=", "result")
    // A result this side did not accept (a mirror's, ADR 0323) is no result.
    .where("item.status", "=", "completed")
    .where((eb) =>
      eb.or([
        eb("turn.status", "is", null),
        eb("turn.status", "<>", "rolled_back"),
      ]),
    )
    .orderBy("item.session_id")
    .orderBy(sql`item.payload->>'name'`)
    .orderBy("item.position", "desc")
    .execute();
  const newest = await newestRequests(db, [
    ...new Set(rows.map((row) => row.session_id)),
  ]);
  for (const row of rows) {
    const item = itemFromRow(row);
    if (item.kind !== "result") continue;
    const input = newest.get(item.sessionId);
    const truncated =
      Buffer.byteLength(JSON.stringify(item.value), "utf8") >
      LATEST_RESULT_VALUE_BYTES;
    const entry: LatestResult = {
      id: item.id,
      name: item.name,
      value: truncated ? null : item.value,
      truncated,
      current: isCurrent(item.input, input),
      turnId: item.turnId,
      recordedAt: item.createdAt,
    };
    latest.set(item.sessionId, [...(latest.get(item.sessionId) ?? []), entry]);
  }
  return latest;
}

/** A child's results as lines of the message it sends its parent. */
export function resultLines(results: readonly LatestResult[]): string {
  if (results.length === 0) return "";
  return [
    "Its results (the latest of each name):",
    ...results.map((result) =>
      result.truncated
        ? `- ${result.name}: too large to show here; read it with session_results (result ${result.id}).`
        : `- ${result.name}: ${JSON.stringify(result.value)}`,
    ),
  ].join("\n");
}
