import {
  ACTIVE_TURN_STATUSES,
  type CommandReceipt,
  type Item,
  type JsonObject,
  SETTLED_TURN_STATUSES,
  type SessionEvent,
  type SessionFields,
  type SessionSnapshot,
  type StoredSessionEvent,
  type TurnStatus,
} from "@catamorphic/agent-protocol";
import type { DB, Json } from "@catamorphic/db";
import { type Kysely, sql, type Transaction } from "kysely";

type Executor = Kysely<DB> | Transaction<DB>;

/** A command that refused: its receipt says why, and repeats say the same. */
export class SessionCommandRejectedError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409,
  ) {
    super(message);
    this.name = "SessionCommandRejectedError";
  }
}

/** The replicated log does not continue where this copy's log ends. */
export class SessionLogGapError extends Error {
  constructor(
    readonly sessionId: string,
    readonly expected: number,
    readonly received: number,
  ) {
    super(
      `Session ${sessionId} expected event ${expected}, received ${received}`,
    );
    this.name = "SessionLogGapError";
  }
}

function json(value: unknown): Json {
  return JSON.parse(JSON.stringify(value ?? null)) as Json;
}

/** Bounds of one replay; beyond them a reader takes a fresh snapshot. */
export const REPLAY_MAX_EVENTS = 256;
export const REPLAY_MAX_BYTES = 1024 * 1024;

/**
 * The session event log (ADR 0197): the only writer of a session's turns,
 * attempts, items, runtime requests, provider threads and visible fields.
 * Events and their projections commit in one transaction; sequences are
 * per session, gapless, allocated under the session row lock.
 */
export class SessionLog {
  constructor(private readonly db: Kysely<DB>) {}

  /**
   * Append events and project them. Must run inside the caller's
   * transaction so the events and the change that caused them commit
   * together. Locks the session row until that transaction ends.
   */
  /**
   * Take the session row's lock now, before reading what an append will be
   * computed from: everything that changes a session locks it first, so
   * what is read under the lock is current until the transaction ends.
   */
  async lock(trx: Transaction<DB>, sessionId: string): Promise<void> {
    await trx
      .selectFrom("agent_sessions")
      .select("id")
      .where("id", "=", sessionId)
      .forUpdate()
      .executeTakeFirstOrThrow();
  }

  async append(
    trx: Transaction<DB>,
    input: {
      sessionId: string;
      events: readonly SessionEvent[];
      commandId?: string | null;
    },
  ): Promise<StoredSessionEvent[]> {
    if (input.events.length === 0) return [];
    await this.lock(trx, input.sessionId);
    const events = await currentTurns(trx, input);
    if (events.length === 0) return [];
    return this.appendLocked(trx, { ...input, events });
  }

  private async appendLocked(
    trx: Transaction<DB>,
    input: {
      sessionId: string;
      events: readonly SessionEvent[];
      commandId?: string | null;
    },
  ): Promise<StoredSessionEvent[]> {
    const allocated = await trx
      .updateTable("agent_sessions")
      .set(({ ref }) => ({
        event_sequence: sql`${ref("event_sequence")} + ${input.events.length}`,
      }))
      .where("id", "=", input.sessionId)
      .returning("event_sequence")
      .executeTakeFirst();
    if (!allocated)
      throw new Error(`Agent session '${input.sessionId}' not found`);
    const last = Number(allocated.event_sequence);
    const first = last - input.events.length + 1;
    const at = new Date();
    // An item's position is the sequence of the event that added it, so
    // writers never allocate positions; a later change in the same batch
    // keeps it.
    const positions = new Map<string, number>();
    const stored = input.events.map((event, index): StoredSessionEvent => {
      const sequence = first + index;
      let placed = protocolEvent(event);
      if (event.type === "item.added") {
        positions.set(event.item.id, sequence);
        placed = { ...event, item: { ...event.item, position: sequence } };
      } else if (event.type === "item.changed") {
        const position = positions.get(event.item.id);
        if (position !== undefined)
          placed = { ...event, item: { ...event.item, position } };
      }
      return {
        sessionId: input.sessionId,
        sequence,
        at: at.toISOString(),
        commandId: input.commandId ?? null,
        event: placed,
      };
    });
    await this.persist(trx, stored);
    return stored;
  }

  /**
   * Apply events another copy of the session committed, keeping their
   * sequences (a mirror, ADR 0197). They must continue this copy's log.
   */
  async replicate(
    trx: Transaction<DB>,
    input: { sessionId: string; events: readonly StoredSessionEvent[] },
  ): Promise<number> {
    const current = await trx
      .selectFrom("agent_sessions")
      .select("event_sequence")
      .where("id", "=", input.sessionId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    let sequence = Number(current.event_sequence);
    const fresh = input.events.filter((event) => event.sequence > sequence);
    for (const event of fresh) {
      if (event.sequence !== sequence + 1)
        throw new SessionLogGapError(
          input.sessionId,
          sequence + 1,
          event.sequence,
        );
      sequence = event.sequence;
    }
    if (fresh.length === 0) return sequence;
    const own = await ownEvents(trx, {
      sessionId: input.sessionId,
      events: fresh.map((event) => event.event),
    });
    await trx
      .updateTable("agent_sessions")
      .set({ event_sequence: sequence })
      .where("id", "=", input.sessionId)
      .execute();
    await this.persist(
      trx,
      fresh.map((event, index) => ({
        ...event,
        sessionId: input.sessionId,
        event: own[index] ?? event.event,
      })),
    );
    return sequence;
  }

  /**
   * Start a copy of a session from another copy's snapshot (a mirror's
   * first push, ADR 0197): its entities are projected as they stand, and
   * the copy's log continues from the snapshot's sequence.
   */
  async importSnapshot(
    trx: Transaction<DB>,
    input: { sessionId: string; snapshot: SessionSnapshot },
  ): Promise<void> {
    const at = new Date().toISOString();
    const events: SessionEvent[] = [
      ...input.snapshot.providerThreads.map(
        (thread): SessionEvent => ({ type: "provider_thread.changed", thread }),
      ),
      ...input.snapshot.items.map(
        (item): SessionEvent => ({ type: "item.added", item }),
      ),
      ...input.snapshot.turns.map(
        (turn): SessionEvent => ({ type: "turn.changed", turn }),
      ),
      ...input.snapshot.attempts.map(
        (attempt): SessionEvent => ({ type: "attempt.changed", attempt }),
      ),
      ...input.snapshot.requests.map(
        (request): SessionEvent => ({ type: "request.changed", request }),
      ),
    ];
    for (const event of await ownEvents(trx, {
      sessionId: input.sessionId,
      events,
    }))
      await project(trx, {
        sessionId: input.sessionId,
        sequence: input.snapshot.sequence,
        at,
        commandId: null,
        event,
      });
    // Never behind what the session already logged.
    await trx
      .updateTable("agent_sessions")
      .set({
        event_sequence: sql`greatest(event_sequence, ${input.snapshot.sequence})`,
      })
      .where("id", "=", input.sessionId)
      .execute();
  }

  /**
   * Whether this copy of a session logged any event. One that did not
   * holds only what a snapshot gave it, or what it had before the log (a
   * chat converted by migration 045).
   */
  async hasLogged(db: Executor, sessionId: string): Promise<boolean> {
    const row = await db
      .selectFrom("agent_session_events")
      .select("sequence")
      .where("session_id", "=", sessionId)
      .limit(1)
      .executeTakeFirst();
    return row !== undefined;
  }

  /**
   * Empty a copy that logged nothing, so a snapshot replaces it whole (a
   * mirror's base over a converted or stale copy, ADR 0197). A copy with a
   * log of its own is refused: its turns are not another copy's to replace.
   */
  async clearUnlogged(
    trx: Transaction<DB>,
    input: { sessionId: string },
  ): Promise<void> {
    if (await this.hasLogged(trx, input.sessionId))
      throw new Error(
        `Session ${input.sessionId} has a log of its own; a snapshot cannot replace it`,
      );
    // Attempts and turn commands go with their turns, entries with threads.
    await trx
      .deleteFrom("agent_runtime_requests")
      .where("session_id", "=", input.sessionId)
      .execute();
    await trx
      .deleteFrom("agent_turns")
      .where("session_id", "=", input.sessionId)
      .execute();
    await trx
      .deleteFrom("agent_items")
      .where("session_id", "=", input.sessionId)
      .execute();
    await trx
      .deleteFrom("agent_provider_threads")
      .where("session_id", "=", input.sessionId)
      .execute();
    await trx
      .deleteFrom("agent_session_commands")
      .where("session_id", "=", input.sessionId)
      .execute();
    await trx
      .updateTable("agent_sessions")
      .set({ event_sequence: 0 })
      .where("id", "=", input.sessionId)
      .execute();
  }

  private async persist(
    trx: Transaction<DB>,
    stored: readonly StoredSessionEvent[],
  ): Promise<void> {
    await trx
      .insertInto("agent_session_events")
      .values(
        stored.map((event) => ({
          session_id: event.sessionId,
          sequence: event.sequence,
          type: event.event.type,
          payload: json(event.event),
          command_id: event.commandId,
          created_at: new Date(event.at),
        })),
      )
      .execute();
    for (const event of stored) await project(trx, event);
  }

  /**
   * Run a command at most once (ADR 0197). A command id seen before returns
   * its first receipt and runs nothing. `run` writes through `append` in
   * the same transaction; a {@link SessionCommandRejectedError} it throws
   * becomes a durable rejection, anything else rolls back and is retried
   * by the caller with the same id.
   */
  async command(input: {
    sessionId: string;
    commandId: string;
    type: string;
    externalUserId?: string;
    /** Returns the command's result (JSON-able), recorded on its receipt. */
    run: (trx: Transaction<DB>) => Promise<object | null | undefined>;
    /**
     * Work outside the database the command needs first (rewinding files),
     * run once the command is known to be new; a rejection it throws is
     * recorded like one from `run`.
     */
    before?: () => Promise<void>;
  }): Promise<CommandReceipt> {
    const existing = await this.receipt(this.db, input);
    if (existing) return existing;
    try {
      await input.before?.();
      return await this.db.transaction().execute(async (trx) => {
        // The session row lock orders concurrent commands; the receipt
        // check inside it makes a duplicate that raced the first one wait
        // and then answer with its receipt.
        await trx
          .selectFrom("agent_sessions")
          .select("id")
          .where("id", "=", input.sessionId)
          .forUpdate()
          .executeTakeFirstOrThrow();
        const raced = await this.receipt(trx, input);
        if (raced) return raced;
        const ran = await input.run(trx);
        const result = ran
          ? (JSON.parse(JSON.stringify(ran)) as JsonObject)
          : null;
        const sequence = await this.latestSequence(trx, input.sessionId);
        await trx
          .insertInto("agent_session_commands")
          .values({
            session_id: input.sessionId,
            command_id: input.commandId,
            type: input.type,
            status: "accepted",
            sequence,
            result: json(result),
            error: null,
            external_user_id: input.externalUserId ?? null,
          })
          .execute();
        return {
          commandId: input.commandId,
          status: "accepted" as const,
          sequence,
          result,
          error: null,
        };
      });
    } catch (error) {
      if (!(error instanceof SessionCommandRejectedError)) throw error;
      const sequence = await this.latestSequence(this.db, input.sessionId);
      const refusal = { code: error.code, message: error.message };
      await this.db
        .insertInto("agent_session_commands")
        .values({
          session_id: input.sessionId,
          command_id: input.commandId,
          type: input.type,
          status: "rejected",
          sequence,
          result: null,
          error: json(refusal),
          external_user_id: input.externalUserId ?? null,
        })
        .onConflict((conflict) =>
          conflict.columns(["session_id", "command_id"]).doNothing(),
        )
        .execute();
      return (
        (await this.receipt(this.db, input)) ?? {
          commandId: input.commandId,
          status: "rejected",
          sequence,
          result: null,
          error: refusal,
        }
      );
    }
  }

  private async receipt(
    db: Executor,
    input: { sessionId: string; commandId: string },
  ): Promise<CommandReceipt | null> {
    const row = await db
      .selectFrom("agent_session_commands")
      .selectAll()
      .where("session_id", "=", input.sessionId)
      .where("command_id", "=", input.commandId)
      .executeTakeFirst();
    if (!row) return null;
    return {
      commandId: row.command_id,
      status: row.status === "rejected" ? "rejected" : "accepted",
      sequence: Number(row.sequence),
      result: (row.result as JsonObject | null) ?? null,
      error: (row.error as CommandReceipt["error"]) ?? null,
    };
  }

  async latestSequence(db: Executor, sessionId: string): Promise<number> {
    const row = await db
      .selectFrom("agent_sessions")
      .select("event_sequence")
      .where("id", "=", sessionId)
      .executeTakeFirst();
    return row ? Number(row.event_sequence) : 0;
  }

  /**
   * Events after `after`, in order, or `reset` when more than a replay's
   * bounds separate the reader from the log (it should take a snapshot).
   */
  async eventsAfter(input: {
    sessionId: string;
    after: number;
    maxEvents?: number;
    maxBytes?: number;
  }): Promise<
    { reset: true } | { reset: false; events: StoredSessionEvent[] }
  > {
    const maxEvents = input.maxEvents ?? REPLAY_MAX_EVENTS;
    const maxBytes = input.maxBytes ?? REPLAY_MAX_BYTES;
    const rows = await this.db
      .selectFrom("agent_session_events")
      .select([
        "session_id",
        "sequence",
        "payload",
        "command_id",
        "created_at",
        sql<number>`octet_length(payload::text)`.as("bytes"),
      ])
      .where("session_id", "=", input.sessionId)
      .where("sequence", ">", String(input.after))
      .orderBy("sequence")
      .limit(maxEvents + 1)
      .execute();
    if (rows.length > maxEvents) return { reset: true };
    let bytes = 0;
    for (const row of rows) bytes += Number(row.bytes);
    if (bytes > maxBytes) return { reset: true };
    return { reset: false, events: rows.map(storedFromRow) };
  }

  /** Events of many sessions after their cursors, for live streams. */
  async eventsAfterMany(input: {
    cursors: ReadonlyArray<{ sessionId: string; after: number }>;
    limit: number;
  }): Promise<StoredSessionEvent[]> {
    if (input.cursors.length === 0) return [];
    const rows = await this.db
      .selectFrom("agent_session_events as event")
      .where((eb) =>
        eb.or(
          input.cursors.map((cursor) =>
            eb.and([
              eb("event.session_id", "=", cursor.sessionId),
              eb("event.sequence", ">", String(cursor.after)),
            ]),
          ),
        ),
      )
      .select([
        "event.session_id",
        "event.sequence",
        "event.payload",
        "event.command_id",
        "event.created_at",
      ])
      .orderBy("event.session_id")
      .orderBy("event.sequence")
      .limit(input.limit)
      .execute();
    return rows.map(storedFromRow);
  }
}

function storedFromRow(row: {
  session_id: string;
  sequence: string | number | bigint;
  payload: Json;
  command_id: string | null;
  created_at: Date;
}): StoredSessionEvent {
  return {
    sessionId: row.session_id,
    sequence: Number(row.sequence),
    at: row.created_at.toISOString(),
    commandId: row.command_id,
    event: row.payload as unknown as SessionEvent,
  };
}

// ---------------------------------------------------------------------------
// The projector: the only writer of the session's projection tables.

async function project(
  trx: Transaction<DB>,
  stored: StoredSessionEvent,
): Promise<void> {
  const event = stored.event;
  switch (event.type) {
    case "session.changed":
      await projectSession(trx, stored.sessionId, event.session);
      return;
    case "turn.changed": {
      const turn = event.turn;
      const values = {
        status: turn.status,
        input_item_id: turn.inputItemId,
        dispatch: turn.dispatch,
        priority: turn.priority,
        activity: turn.activity,
        activity_at: turn.activityAt ? new Date(turn.activityAt) : null,
        attempt_count: turn.attemptCount,
        active_attempt_id: turn.activeAttemptId,
        provider_thread_id: turn.providerThreadId,
        error: turn.error ? json(turn.error) : null,
        outcome: turn.outcome ? json(turn.outcome) : null,
        checkpoint_before: turn.checkpoint.before,
        checkpoint_after: turn.checkpoint.after,
        continuation_of: turn.continuationOf,
        started_at: turn.startedAt ? new Date(turn.startedAt) : null,
        completed_at: turn.completedAt ? new Date(turn.completedAt) : null,
        updated_at: new Date(turn.updatedAt),
      };
      await trx
        .insertInto("agent_turns")
        .values({
          id: turn.id,
          session_id: stored.sessionId,
          ordinal: turn.ordinal,
          created_at: new Date(turn.createdAt),
          ...(turn.retryAt ? { available_at: new Date(turn.retryAt) } : {}),
          ...(turn.cancellationRequested
            ? { cancellation_requested_at: new Date(stored.at) }
            : {}),
          ...values,
        })
        .onConflict((conflict) =>
          conflict
            .column("id")
            .doUpdateSet((eb) => ({
              ...values,
              // A request to stop stands until the turn leaves its run
              // (queued again, restarting, settled): a turn written while
              // it still runs never withdraws one made meanwhile.
              cancellation_requested_at: turn.cancellationRequested
                ? sql`coalesce(${eb.ref("agent_turns.cancellation_requested_at")}, ${new Date(stored.at)})`
                : (ACTIVE_TURN_STATUSES as readonly TurnStatus[]).includes(
                      turn.status,
                    )
                  ? eb.ref("agent_turns.cancellation_requested_at")
                  : null,
            }))
            .where("agent_turns.session_id", "=", stored.sessionId),
        )
        .execute();
      return;
    }
    case "attempt.changed": {
      const attempt = event.attempt;
      const values = {
        status: attempt.status,
        provider_thread_id: attempt.providerThreadId,
        native_turn_ref: attempt.nativeTurnRef
          ? json(attempt.nativeTurnRef)
          : null,
        error: attempt.error ? json(attempt.error) : null,
        started_at: attempt.startedAt ? new Date(attempt.startedAt) : null,
        completed_at: attempt.completedAt
          ? new Date(attempt.completedAt)
          : null,
      };
      await trx
        .insertInto("agent_turn_attempts")
        .values({
          id: attempt.id,
          turn_id: attempt.turnId,
          session_id: stored.sessionId,
          ordinal: attempt.ordinal,
          reason: attempt.reason,
          created_at: new Date(attempt.createdAt),
          ...values,
        })
        .onConflict((conflict) =>
          conflict
            .column("id")
            .doUpdateSet(values)
            .where("agent_turn_attempts.session_id", "=", stored.sessionId),
        )
        .execute();
      return;
    }
    case "item.added":
    case "item.changed":
      await projectItem(trx, stored.sessionId, event.item);
      return;
    case "item.text_appended": {
      const path = event.field === "output" ? "{output}" : "{text}";
      const field = event.field;
      await trx
        .updateTable("agent_items")
        .set(({ ref }) => ({
          payload: sql`jsonb_set(jsonb_set(${ref("payload")}, ${path}::text[], to_jsonb(coalesce(${ref("payload")}->>${field}, '') || ${event.text}::text)), '{updatedAt}', to_jsonb(${event.at}::text))`,
          ...(field === "text"
            ? { text: sql`${ref("text")} || ${event.text}::text` }
            : {}),
          updated_at: new Date(event.at),
        }))
        .where("id", "=", event.itemId)
        .where("session_id", "=", stored.sessionId)
        .execute();
      return;
    }
    case "request.changed": {
      const request = event.request;
      const values = {
        turn_id: request.turnId,
        attempt_id: request.attemptId,
        item_id: request.itemId,
        kind: request.kind,
        payload: json(request),
        status: request.status,
        answerable: request.answerable,
        blocking: request.blocking,
        expires_at: request.expiresAt ? new Date(request.expiresAt) : null,
        response: request.response ? json(request.response) : null,
        resolved_by_external_user_id: request.resolvedBy,
        resolved_at: request.resolvedAt ? new Date(request.resolvedAt) : null,
        reason: request.reason,
        updated_at: new Date(stored.at),
      };
      await trx
        .insertInto("agent_runtime_requests")
        .values({
          session_id: stored.sessionId,
          request_id: request.id,
          created_at: new Date(request.createdAt),
          ...values,
        })
        .onConflict((conflict) =>
          conflict.columns(["session_id", "request_id"]).doUpdateSet((eb) => ({
            ...values,
            revision: sql`${eb.ref("agent_runtime_requests.revision")} + 1`,
          })),
        )
        .execute();
      return;
    }
    case "provider_thread.changed": {
      const thread = event.thread;
      const values = {
        harness: thread.harness,
        native_ref: thread.nativeRef ? json(thread.nativeRef) : null,
        status: thread.status,
        last_turn_ordinal: thread.lastTurnOrdinal,
        portable: thread.portable,
        updated_at: new Date(thread.updatedAt),
      };
      await trx
        .insertInto("agent_provider_threads")
        .values({
          id: thread.id,
          session_id: stored.sessionId,
          created_at: new Date(thread.createdAt),
          ...values,
        })
        .onConflict((conflict) =>
          conflict
            .column("id")
            .doUpdateSet(values)
            .where("agent_provider_threads.session_id", "=", stored.sessionId),
        )
        .execute();
      return;
    }
  }
}

async function projectItem(
  trx: Transaction<DB>,
  sessionId: string,
  item: Item,
): Promise<void> {
  const user = item.kind === "user_message" ? item : undefined;
  const values = {
    turn_id: item.turnId,
    attempt_id: item.attemptId,
    parent_item_id: item.parentItemId,
    kind: item.kind,
    status: item.status,
    text: itemText(item),
    author_kind: user
      ? user.author.kind
      : item.kind === "assistant_message"
        ? "agent"
        : item.kind === "notice"
          ? "system"
          : null,
    author_payload: user
      ? json(user.author)
      : item.kind === "assistant_message"
        ? json({
            kind: "agent",
            sessionId: item.sessionId,
            agentId: item.agentId,
          })
        : null,
    dispatch: user ? user.dispatch : null,
    attention: user?.attention === "required",
    idempotency_key: user?.idempotencyKey ?? null,
    payload: json(item),
    updated_at: new Date(item.updatedAt),
  };
  await trx
    .insertInto("agent_items")
    .values({
      id: item.id,
      session_id: sessionId,
      position: item.position,
      created_at: new Date(item.createdAt),
      ...values,
    })
    // Positions never change: the stored one wins, and so does its payload copy.
    .onConflict((conflict) =>
      conflict
        .column("id")
        .doUpdateSet((eb) => ({
          ...values,
          payload: sql`jsonb_set(${json(item)}::jsonb, '{position}', to_jsonb(${eb.ref("agent_items.position")}))`,
        }))
        .where("agent_items.session_id", "=", sessionId),
    )
    .execute();
}

/** The searchable text of an item: what workflow events and search read. */
export function itemText(item: Item): string {
  switch (item.kind) {
    case "user_message":
    case "assistant_message":
    case "reasoning":
    case "notice":
    case "context_handoff":
      return item.text;
    case "command":
      return item.description ?? item.command;
    case "tool_call":
      return item.description ?? item.tool;
    case "file_change":
      return item.path;
    case "subagent":
      return item.title;
    case "plan":
      return item.steps.map((step) => step.text).join("\n");
    case "request":
      return "";
  }
}

async function projectSession(
  trx: Transaction<DB>,
  sessionId: string,
  fields: Partial<SessionFields>,
): Promise<void> {
  const set: Record<string, unknown> = {};
  if ("title" in fields) set.title = fields.title;
  if ("icon" in fields) set.icon = fields.icon;
  if ("agentId" in fields) set.agent_id = fields.agentId;
  if ("harness" in fields) set.harness = fields.harness;
  if ("model" in fields) set.model = fields.model;
  if ("modelEffort" in fields) set.model_effort = fields.modelEffort;
  if ("status" in fields) set.status = fields.status;
  if ("workStatus" in fields) set.work_status = fields.workStatus;
  if ("activity" in fields) set.activity = fields.activity;
  if ("todos" in fields) set.todos = json(fields.todos ?? []);
  if ("attentionRevision" in fields)
    set.attention_revision = fields.attentionRevision;
  if ("environment" in fields) set.environment_name = fields.environment;
  if ("authorityHostId" in fields)
    set.authority_host_id = fields.authorityHostId;
  if ("authorityRevision" in fields)
    set.authority_revision = fields.authorityRevision;
  if ("handoffStatus" in fields) set.handoff_status = fields.handoffStatus;
  if ("parentSessionId" in fields)
    set.parent_session_id = fields.parentSessionId;
  if (Object.keys(set).length === 0) return;
  set.updated_at = fields.updatedAt ? new Date(fields.updatedAt) : new Date();
  await trx
    .updateTable("agent_sessions")
    .set(set)
    .where("id", "=", sessionId)
    .execute();
}

/**
 * An event as the protocol defines it, whatever a writer spread into its
 * entity: engine state (a runner's location, its cursor) stays in its own
 * columns and never reaches the log or a client.
 */
function protocolEvent(event: SessionEvent): SessionEvent {
  switch (event.type) {
    case "attempt.changed": {
      const a = event.attempt;
      return {
        type: "attempt.changed",
        attempt: {
          id: a.id,
          turnId: a.turnId,
          sessionId: a.sessionId,
          ordinal: a.ordinal,
          reason: a.reason,
          status: a.status,
          providerThreadId: a.providerThreadId,
          nativeTurnRef: a.nativeTurnRef,
          error: a.error,
          createdAt: a.createdAt,
          startedAt: a.startedAt,
          completedAt: a.completedAt,
        },
      };
    }
    case "provider_thread.changed": {
      const t = event.thread;
      return {
        type: "provider_thread.changed",
        thread: {
          id: t.id,
          sessionId: t.sessionId,
          harness: t.harness,
          nativeRef: t.nativeRef,
          status: t.status,
          lastTurnOrdinal: t.lastTurnOrdinal,
          portable: t.portable,
          createdAt: t.createdAt,
          updatedAt: t.updatedAt,
        },
      };
    }
    default:
      return event;
  }
}

/** A copy's events named something outside the session they were sent for. */
export class ForeignSessionEventError extends Error {
  constructor(readonly sessionId: string) {
    super(`A copy of session '${sessionId}' named records of another session`);
    this.name = "ForeignSessionEventError";
  }
}

/**
 * Session fields another copy may set: what it shows, never who runs it.
 * Replica memory (c): a constant, the same on every replica.
 */
const COPIED_SESSION_FIELDS = new Set([
  "title",
  "icon",
  "todos",
  "workStatus",
  "activity",
  "updatedAt",
]);

/**
 * Turn changes as they apply to the turns as they stand, read under the
 * session lock: a writer that read a turn before it settled never puts it
 * back to work, and one that read it before a stop never withdraws it. The
 * log then folds into exactly what the projection holds.
 */
async function currentTurns(
  trx: Transaction<DB>,
  input: { sessionId: string; events: readonly SessionEvent[] },
): Promise<SessionEvent[]> {
  const ids = input.events.flatMap((event) =>
    event.type === "turn.changed" ? [event.turn.id] : [],
  );
  if (ids.length === 0) return [...input.events];
  const rows = await trx
    .selectFrom("agent_turns")
    .select(["id", "status", "cancellation_requested_at"])
    .where("session_id", "=", input.sessionId)
    .where("id", "in", ids)
    .execute();
  const current = new Map(rows.map((row) => [row.id, row]));
  const active = (status: string) =>
    (ACTIVE_TURN_STATUSES as readonly string[]).includes(status);
  return input.events.flatMap((event): SessionEvent[] => {
    if (event.type !== "turn.changed") return [event];
    const row = current.get(event.turn.id);
    if (!row) return [event];
    if (
      (SETTLED_TURN_STATUSES as readonly string[]).includes(row.status) &&
      active(event.turn.status)
    )
      return [];
    if (
      active(event.turn.status) &&
      !event.turn.cancellationRequested &&
      row.cancellation_requested_at !== null
    )
      return [
        { ...event, turn: { ...event.turn, cancellationRequested: true } },
      ];
    return [event];
  });
}

/**
 * Events another copy sent (a mirror's push or base, ADR 0197), checked
 * before anything is projected: every record they carry belongs to this
 * session and to no other, every turn they name is this session's, and a
 * session change keeps only presentation fields. Agent, Environment,
 * authority and hierarchy change only through this side's own operations.
 */
async function ownEvents(
  trx: Transaction<DB>,
  input: { sessionId: string; events: readonly SessionEvent[] },
): Promise<SessionEvent[]> {
  const ids = {
    turns: new Set<string>(),
    attempts: new Set<string>(),
    items: new Set<string>(),
    threads: new Set<string>(),
  };
  const turnRefs = new Set<string>();
  const requests = new Set<string>();
  const foreign = () => new ForeignSessionEventError(input.sessionId);
  const own = input.events.map((event): SessionEvent => {
    switch (event.type) {
      case "session.changed":
        return {
          type: "session.changed",
          session: Object.fromEntries(
            Object.entries(event.session).filter(([key]) =>
              COPIED_SESSION_FIELDS.has(key),
            ),
          ),
        };
      case "turn.changed":
        if (event.turn.sessionId !== input.sessionId) throw foreign();
        ids.turns.add(event.turn.id);
        return event;
      case "attempt.changed":
        if (event.attempt.sessionId !== input.sessionId) throw foreign();
        ids.attempts.add(event.attempt.id);
        turnRefs.add(event.attempt.turnId);
        return event;
      case "item.added":
      case "item.changed":
        if (event.item.sessionId !== input.sessionId) throw foreign();
        ids.items.add(event.item.id);
        if (event.item.turnId) turnRefs.add(event.item.turnId);
        return event;
      case "item.text_appended":
        ids.items.add(event.itemId);
        return event;
      case "request.changed":
        if (event.request.sessionId !== input.sessionId) throw foreign();
        requests.add(event.request.id);
        if (event.request.turnId) turnRefs.add(event.request.turnId);
        if (event.request.attemptId) ids.attempts.add(event.request.attemptId);
        if (event.request.itemId) ids.items.add(event.request.itemId);
        return event;
      case "provider_thread.changed":
        if (event.thread.sessionId !== input.sessionId) throw foreign();
        ids.threads.add(event.thread.id);
        return event;
      default:
        throw foreign();
    }
  });
  const elsewhere = async (
    table:
      | "agent_turns"
      | "agent_turn_attempts"
      | "agent_items"
      | "agent_provider_threads",
    values: Set<string>,
  ) =>
    values.size > 0 &&
    (await trx
      .selectFrom(table)
      .select("id")
      .where("id", "in", [...values])
      .where("session_id", "!=", input.sessionId)
      .executeTakeFirst()) !== undefined;
  for (const turnId of turnRefs) ids.turns.add(turnId);
  if (
    (await elsewhere("agent_turns", ids.turns)) ||
    (await elsewhere("agent_turn_attempts", ids.attempts)) ||
    (await elsewhere("agent_items", ids.items)) ||
    (await elsewhere("agent_provider_threads", ids.threads)) ||
    (requests.size > 0 &&
      (await trx
        .selectFrom("agent_runtime_requests")
        .select("request_id")
        .where("request_id", "in", [...requests])
        .where("session_id", "!=", input.sessionId)
        .executeTakeFirst()) !== undefined)
  )
    throw foreign();
  return own;
}
