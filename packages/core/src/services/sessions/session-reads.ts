import type {
  Item,
  SessionSnapshot,
  Turn,
} from "@catamorphic/agent-protocol";
import type { DB } from "@catamorphic/db";
import type { Kysely, Transaction } from "kysely";
import {
  attemptFromRow,
  itemFromRow,
  providerThreadFromRow,
  requestFromRow,
  sessionFieldsFromRow,
  turnFromRow,
} from "./session-rows.js";

type Executor = Kysely<DB> | Transaction<DB>;

/** Turns a snapshot carries; older ones page in by item position. */
export const SNAPSHOT_TURNS = 30;
/** Items one page of history carries. */
export const HISTORY_PAGE_ITEMS = 400;

/**
 * A bounded snapshot at one sequence (ADR 0195): the session's fields, its
 * recent turns with their attempts and items, every turn still waiting or
 * working, and open requests. One repeatable-read transaction, so the
 * sequence describes exactly what it holds.
 */
export async function readSnapshot(input: {
  db: Kysely<DB>;
  sessionId: string;
  turns?: number;
}): Promise<SessionSnapshot> {
  return input.db
    .transaction()
    .setIsolationLevel("repeatable read")
    .execute(async (trx) => {
      const session = await trx
        .selectFrom("agent_sessions")
        .selectAll()
        .where("id", "=", input.sessionId)
        .executeTakeFirstOrThrow();
      const recent = await trx
        .selectFrom("agent_turns")
        .selectAll()
        .where("session_id", "=", input.sessionId)
        .orderBy("ordinal", "desc")
        .limit(input.turns ?? SNAPSHOT_TURNS)
        .execute();
      const pending = await trx
        .selectFrom("agent_turns")
        .selectAll()
        .where("session_id", "=", input.sessionId)
        .where("status", "in", [
          "queued",
          "held",
          "preparing",
          "running",
          "waiting",
          "finalizing",
        ])
        .execute();
      const turnRows = new Map(
        [...recent, ...pending].map((row) => [row.id, row]),
      );
      const turns = [...turnRows.values()]
        .map(turnFromRow)
        .sort((a, b) => a.ordinal - b.ordinal);
      // Items from the earliest recent turn's first item on, plus inputs of
      // queued turns (and notices) wherever they are.
      const earliest = turns[0];
      const from = earliest
        ? await firstPosition(trx, input.sessionId, earliest.id)
        : null;
      const itemRows = await trx
        .selectFrom("agent_items")
        .select("payload")
        .where("session_id", "=", input.sessionId)
        .$if(from !== null, (query) =>
          query.where((eb) =>
            eb.or([
              eb("position", ">=", String(from ?? 0)),
              eb(
                "turn_id",
                "in",
                pending.length > 0 ? pending.map((row) => row.id) : ["00000000-0000-0000-0000-000000000000"],
              ),
            ]),
          ),
        )
        .orderBy("position")
        .execute();
      const older =
        from !== null
          ? await trx
              .selectFrom("agent_items")
              .select("position")
              .where("session_id", "=", input.sessionId)
              .where("position", "<", String(from))
              .limit(1)
              .executeTakeFirst()
          : undefined;
      const attempts = turns.length
        ? await trx
            .selectFrom("agent_turn_attempts")
            .selectAll()
            .where(
              "turn_id",
              "in",
              turns.map((turn) => turn.id),
            )
            .execute()
        : [];
      const requests = await trx
        .selectFrom("agent_runtime_requests")
        .selectAll()
        .where("session_id", "=", input.sessionId)
        .where((eb) =>
          eb.or([
            eb("status", "=", "pending"),
            eb(
              "turn_id",
              "in",
              turns.length ? turns.map((turn) => turn.id) : [""],
            ),
          ]),
        )
        .execute();
      const threads = await trx
        .selectFrom("agent_provider_threads")
        .selectAll()
        .where("session_id", "=", input.sessionId)
        .execute();
      return {
        sequence: Number(session.event_sequence),
        session: sessionFieldsFromRow(session),
        turns,
        attempts: attempts.map(attemptFromRow),
        items: itemRows.map(itemFromRow),
        requests: requests.map(requestFromRow),
        providerThreads: threads.map(providerThreadFromRow),
        olderBefore: older && from !== null ? from : null,
      };
    });
}

async function firstPosition(
  db: Executor,
  sessionId: string,
  turnId: string,
): Promise<number | null> {
  const row = await db
    .selectFrom("agent_items")
    .select((eb) => eb.fn.min("position").as("position"))
    .where("session_id", "=", sessionId)
    .where("turn_id", "=", turnId)
    .executeTakeFirst();
  return row?.position === null || row?.position === undefined
    ? null
    : Number(row.position);
}

/**
 * Every turn, item, request and thread of a session at one sequence: what a
 * mirror sends to start a copy elsewhere (ADR 0195).
 */
export async function readFullSnapshot(input: {
  db: Kysely<DB>;
  sessionId: string;
}): Promise<SessionSnapshot> {
  return input.db
    .transaction()
    .setIsolationLevel("repeatable read")
    .execute(async (trx) => {
      const session = await trx
        .selectFrom("agent_sessions")
        .selectAll()
        .where("id", "=", input.sessionId)
        .executeTakeFirstOrThrow();
      const turns = await trx.selectFrom("agent_turns").selectAll().where("session_id", "=", input.sessionId).orderBy("ordinal").execute();
      const items = await trx.selectFrom("agent_items").select("payload").where("session_id", "=", input.sessionId).orderBy("position").execute();
      const attempts = await trx.selectFrom("agent_turn_attempts").selectAll().where("session_id", "=", input.sessionId).execute();
      const requests = await trx.selectFrom("agent_runtime_requests").selectAll().where("session_id", "=", input.sessionId).execute();
      const threads = await trx.selectFrom("agent_provider_threads").selectAll().where("session_id", "=", input.sessionId).execute();
      return {
        sequence: Number(session.event_sequence),
        session: sessionFieldsFromRow(session),
        turns: turns.map(turnFromRow),
        attempts: attempts.map(attemptFromRow),
        items: items.map(itemFromRow),
        requests: requests.map(requestFromRow),
        providerThreads: threads.map(providerThreadFromRow),
        olderBefore: null,
      };
    });
}

/** Items before `before`, newest page first, with the next cursor. */
export async function readItemsBefore(input: {
  db: Executor;
  sessionId: string;
  before: number;
  limit?: number;
}): Promise<{ items: Item[]; olderBefore: number | null }> {
  const limit = input.limit ?? HISTORY_PAGE_ITEMS;
  const rows = await input.db
    .selectFrom("agent_items")
    .select(["payload", "position"])
    .where("session_id", "=", input.sessionId)
    .where("position", "<", String(input.before))
    .orderBy("position", "desc")
    .limit(limit + 1)
    .execute();
  const page = rows.slice(0, limit).reverse();
  return {
    items: page.map(itemFromRow),
    olderBefore:
      rows.length > limit && page[0] ? Number(page[0].position) : null,
  };
}

/**
 * The conversation as people read it: user and assistant messages and
 * notices, in order, without work steps. What session tools, workflows'
 * `history`, and peers read.
 */
export interface TranscriptMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  turnId: string | null;
  status: Item["status"];
  createdAt: string;
  author: Extract<Item, { kind: "user_message" }>["author"] | null;
}

export async function readTranscript(input: {
  db: Executor;
  sessionId: string;
  /** Up to and including this item. */
  through?: string;
  limit?: number;
}): Promise<TranscriptMessage[]> {
  let throughPosition: number | undefined;
  if (input.through) {
    const row = await input.db
      .selectFrom("agent_items")
      .select("position")
      .where("session_id", "=", input.sessionId)
      .where("id", "=", input.through)
      .executeTakeFirst();
    if (row) throughPosition = Number(row.position);
  }
  const rows = await input.db
    .selectFrom("agent_items")
    .select("payload")
    .where("session_id", "=", input.sessionId)
    .where("kind", "in", ["user_message", "assistant_message", "notice"])
    .$if(throughPosition !== undefined, (query) =>
      query.where("position", "<=", String(throughPosition ?? 0)),
    )
    .orderBy("position", "desc")
    .$if(input.limit !== undefined, (query) => query.limit(input.limit ?? 0))
    .execute();
  return rows
    .reverse()
    .map(itemFromRow)
    .flatMap((item): TranscriptMessage[] => {
      if (item.kind === "user_message")
        return [
          {
            id: item.id,
            role: item.author.kind === "system" ? "system" : "user",
            content: item.text,
            turnId: item.turnId,
            status: item.status,
            createdAt: item.createdAt,
            author: item.author,
          },
        ];
      if (item.kind === "assistant_message")
        return item.text.trim() || item.status === "in_progress"
          ? [
              {
                id: item.id,
                role: "assistant",
                content: item.text,
                turnId: item.turnId,
                status: item.status,
                createdAt: item.createdAt,
                author: null,
              },
            ]
          : [];
      if (item.kind === "notice")
        return [
          {
            id: item.id,
            role: "system",
            content: item.text,
            turnId: item.turnId,
            status: item.status,
            createdAt: item.createdAt,
            author: null,
          },
        ];
      return [];
    });
}

/** The turn's final reply: its last assistant message, if any. */
export async function readReply(input: {
  db: Executor;
  turn: Pick<Turn, "id">;
}): Promise<Item | null> {
  const row = await input.db
    .selectFrom("agent_items")
    .select("payload")
    .where("turn_id", "=", input.turn.id)
    .where("kind", "=", "assistant_message")
    .orderBy("position", "desc")
    .limit(1)
    .executeTakeFirst();
  return row ? itemFromRow(row) : null;
}
