import { randomUUID } from "node:crypto";
import {
  ACTIVE_TURN_STATUSES,
  type JsonObject,
  type Turn,
} from "@catamorphic/agent-protocol";
import type { DB, Json } from "@catamorphic/db";
import { type Kysely, sql, type Transaction } from "kysely";
import type { SessionLog } from "./session-log.js";
import { turnFromRow } from "./session-rows.js";

export const LEASE_SECONDS = 60;

/** A turn this process claimed: fresh from the queue or recovered after a lapsed lease. */
export interface ClaimedTurn {
  turn: Turn;
  leaseToken: string;
  /** It was already past `queued`: another holder's lease lapsed. */
  recovered: boolean;
}

export type TurnCommandKind =
  | "steer"
  | "interrupt"
  | "respond"
  | "release"
  | "stop";

export interface TurnCommand {
  id: string;
  turnId: string;
  attemptId: string | null;
  kind: TurnCommandKind;
  payload: JsonObject;
  status: "pending" | "sent" | "acknowledged" | "dropped";
}

/**
 * The session's queue of turns and the commands for the one running
 * (ADRs 0196, 0197). Whether a turn runs, and who runs it, is decided here
 * in Postgres: a claim takes the queue's head or recovers a turn whose
 * holder's lease lapsed, and one statement a second renews every turn a
 * process holds (ADR 0193).
 */
export class TurnQueue {
  constructor(
    private readonly db: Kysely<DB>,
    private readonly log: SessionLog,
  ) {}

  /**
   * Claim the session's next turn for this process: a turn whose lease
   * lapsed first (its work continues), else the queue's head when no turn
   * works in the session. The session row lock orders claims with every
   * change to the session.
   */
  async claim(input: {
    workerId: string;
    sessionId: string;
    localNode?: { id: string; token: string };
  }): Promise<ClaimedTurn | null> {
    return this.db.transaction().execute(async (trx) => {
      await trx
        .selectFrom("agent_sessions")
        .select("id")
        .where("id", "=", input.sessionId)
        .forUpdate()
        .execute();
      const leaseToken = randomUUID();
      const lapsed = await this.eligible(trx, input)
        .where("turn.status", "in", [...ACTIVE_TURN_STATUSES])
        .where((eb) =>
          eb.or([
            eb("turn.lease_expires_at", "is", null),
            eb("turn.lease_expires_at", "<=", sql<Date>`now()`),
          ]),
        )
        .forUpdate()
        .skipLocked()
        .executeTakeFirst();
      if (lapsed) {
        await this.lease(trx, {
          turnId: lapsed.id,
          workerId: input.workerId,
          leaseToken,
        });
        return {
          turn: turnFromRow(lapsed),
          leaseToken,
          recovered: true,
        };
      }
      const busy = await trx
        .selectFrom("agent_turns")
        .select("id")
        .where("session_id", "=", input.sessionId)
        .where("status", "in", [...ACTIVE_TURN_STATUSES])
        .executeTakeFirst();
      if (busy) return null;
      const head = await this.eligible(trx, input)
        .where("turn.status", "=", "queued")
        .where("turn.available_at", "<=", sql<Date>`now()`)
        .orderBy("turn.priority", "desc")
        .orderBy("turn.created_at")
        .orderBy("turn.ordinal")
        .limit(1)
        .forUpdate()
        .skipLocked()
        .executeTakeFirst();
      if (!head) return null;
      const now = new Date().toISOString();
      const turn: Turn = {
        ...turnFromRow(head),
        status: "preparing",
        activity: "Preparing agent",
        activityAt: now,
        cancellationRequested: false,
        retryAt: null,
        startedAt: head.started_at?.toISOString() ?? now,
        updatedAt: now,
      };
      await this.log.append(trx, {
        sessionId: input.sessionId,
        events: [{ type: "turn.changed", turn }],
      });
      await this.lease(trx, {
        turnId: head.id,
        workerId: input.workerId,
        leaseToken,
      });
      return { turn, leaseToken, recovered: false };
    });
  }

  private async lease(
    trx: Transaction<DB>,
    input: { turnId: string; workerId: string; leaseToken: string },
  ): Promise<void> {
    await trx
      .updateTable("agent_turns")
      .set({
        lease_owner: input.workerId,
        lease_token: input.leaseToken,
        lease_expires_at: sql`now() + (${LEASE_SECONDS} * interval '1 second')`,
      })
      .where("id", "=", input.turnId)
      .execute();
  }

  /**
   * Turns of the session whose workspace this process may drive: on no
   * node, on a remote node with a live lease, on this process's own local
   * node, or on a member's machine whose runner is connected (ADR 0192).
   * Never while a host saves or releases the idle workspace.
   */
  private eligible(
    trx: Transaction<DB>,
    input: { sessionId: string; localNode?: { id: string; token: string } },
  ) {
    return trx
      .selectFrom("agent_turns as turn")
      .selectAll("turn")
      .where("turn.session_id", "=", input.sessionId)
      .where(({ exists, not, selectFrom }) =>
        not(
          exists(
            selectFrom("agent_sessions as session")
              .innerJoin(
                "execution_allocations as allocation",
                "allocation.id",
                "session.allocation_id",
              )
              .select("session.id")
              .whereRef("session.id", "=", "turn.session_id")
              .where((blocked) =>
                blocked.or([
                  blocked(
                    "allocation.maintenance_claimed_until",
                    ">",
                    sql<Date>`now()`,
                  ),
                  blocked.and([
                    blocked("allocation.worker_node_id", "is not", null),
                    blocked.or([
                      blocked("allocation.status", "!=", "active"),
                      blocked.not(
                        blocked.exists(
                          blocked
                            .selectFrom("worker_nodes as node")
                            .select("node.id")
                            .whereRef(
                              "node.id",
                              "=",
                              "allocation.worker_node_id",
                            )
                            .where("node.enabled", "=", true)
                            .where(
                              "node.lease_expires_at",
                              ">",
                              sql<Date>`now()`,
                            )
                            .where((node) =>
                              node.or([
                                node("node.remote", "is not", null),
                                ...(input.localNode
                                  ? [
                                      node.and([
                                        node(
                                          "node.id",
                                          "=",
                                          input.localNode.id,
                                        ),
                                        node(
                                          "node.lease_token",
                                          "=",
                                          input.localNode.token,
                                        ),
                                      ]),
                                    ]
                                  : []),
                              ]),
                            ),
                        ),
                      ),
                    ]),
                  ]),
                  blocked.and([
                    blocked("allocation.worker_node_id", "is", null),
                    blocked("allocation.binding_id", "like", "client:%"),
                    blocked.not(
                      blocked.exists(
                        blocked
                          .selectFrom("client_runners as runner")
                          .select("runner.id")
                          .where(
                            sql<boolean>`runner.id::text = split_part(allocation.binding_id, ':', 2)`,
                          )
                          .where(
                            "runner.lease_expires_at",
                            ">",
                            sql<Date>`now()`,
                          ),
                      ),
                    ),
                  ]),
                ]),
              ),
          ),
        ),
      );
  }

  /**
   * Extend every lease this process still holds, in one statement, and say
   * which turns were asked to stop or have commands waiting (ADR 0193).
   */
  async renewHeld(input: {
    workerId: string;
    turns: ReadonlyArray<{ turnId: string; leaseToken: string }>;
  }): Promise<
    Array<{ turnId: string; cancellationRequested: boolean; commands: boolean }>
  > {
    if (input.turns.length === 0) return [];
    const rows = await this.db
      .updateTable("agent_turns")
      .set({
        lease_expires_at: sql`now() + (${LEASE_SECONDS} * interval '1 second')`,
      })
      .where("lease_owner", "=", input.workerId)
      .where("status", "in", [...ACTIVE_TURN_STATUSES])
      .where("lease_expires_at", ">", sql<Date>`now()`)
      .where(({ and, eb, or }) =>
        or(
          input.turns.map((turn) =>
            and([
              eb("id", "=", turn.turnId),
              eb("lease_token", "=", turn.leaseToken),
            ]),
          ),
        ),
      )
      .returning((eb) => [
        "id",
        "cancellation_requested_at",
        eb
          .exists(
            eb
              .selectFrom("agent_turn_commands as command")
              .select("command.id")
              .whereRef("command.turn_id", "=", "agent_turns.id")
              .where("command.status", "=", "pending"),
          )
          .as("commands"),
      ])
      .execute();
    return rows.map((row) => ({
      turnId: row.id,
      cancellationRequested: row.cancellation_requested_at !== null,
      commands: Boolean(row.commands),
    }));
  }

  /** Whether this lease still holds the turn, for a step that must not run without it. */
  async owns(input: {
    turnId: string;
    leaseToken: string;
    executor?: Kysely<DB> | Transaction<DB>;
  }): Promise<boolean> {
    const row = await (input.executor ?? this.db)
      .selectFrom("agent_turns")
      .select("id")
      .where("id", "=", input.turnId)
      .where("lease_token", "=", input.leaseToken)
      .where("lease_expires_at", ">", sql<Date>`clock_timestamp()`)
      .executeTakeFirst();
    return Boolean(row);
  }

  /** Hand a turn back at once, for a replica to take over (a stopping process). */
  async handBack(input: { turnId: string; leaseToken: string }): Promise<void> {
    await this.db
      .updateTable("agent_turns")
      .set({ lease_expires_at: sql`now()`, lease_owner: null })
      .where("id", "=", input.turnId)
      .where("lease_token", "=", input.leaseToken)
      .execute();
  }

  /** End a lease once its turn settled. */
  async release(
    trx: Transaction<DB>,
    input: { turnId: string },
  ): Promise<void> {
    await trx
      .updateTable("agent_turns")
      .set({ lease_owner: null, lease_token: null, lease_expires_at: null })
      .where("id", "=", input.turnId)
      .execute();
  }

  /** Make a settled turn due again later (a transient failure, ADR 0196). */
  async scheduleRetry(
    trx: Transaction<DB>,
    input: { turnId: string; at: Date },
  ): Promise<void> {
    await trx
      .updateTable("agent_turns")
      .set({ available_at: input.at })
      .where("id", "=", input.turnId)
      .execute();
  }

  async enqueueCommand(
    trx: Transaction<DB>,
    input: {
      turnId: string;
      attemptId?: string | null;
      kind: TurnCommandKind;
      payload?: JsonObject;
    },
  ): Promise<string> {
    const row = await trx
      .insertInto("agent_turn_commands")
      .values({
        turn_id: input.turnId,
        attempt_id: input.attemptId ?? null,
        kind: input.kind,
        payload: (input.payload ?? {}) as Json,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    return row.id;
  }

  /** Commands the runner has not acknowledged, oldest first. */
  async openCommands(input: {
    turnId: string;
    executor?: Kysely<DB> | Transaction<DB>;
  }): Promise<TurnCommand[]> {
    const rows = await (input.executor ?? this.db)
      .selectFrom("agent_turn_commands")
      .selectAll()
      .where("turn_id", "=", input.turnId)
      .where("status", "in", ["pending", "sent"])
      .orderBy("created_at")
      .orderBy("id")
      .execute();
    return rows.map((row) => ({
      id: row.id,
      turnId: row.turn_id,
      attemptId: row.attempt_id,
      kind: commandKind(row.kind),
      payload: (row.payload as JsonObject | null) ?? {},
      status:
        row.status === "sent" ||
        row.status === "acknowledged" ||
        row.status === "dropped"
          ? row.status
          : "pending",
    }));
  }

  async markCommands(input: {
    ids: readonly string[];
    status: "sent" | "acknowledged" | "dropped";
    executor?: Transaction<DB>;
  }): Promise<void> {
    if (input.ids.length === 0) return;
    await (input.executor ?? this.db)
      .updateTable("agent_turn_commands")
      .set({
        status: input.status,
        ...(input.status === "sent" ? { sent_at: new Date() } : {}),
        ...(input.status === "acknowledged"
          ? { acknowledged_at: new Date() }
          : {}),
      })
      .where("id", "in", [...input.ids])
      .where("status", "in", ["pending", "sent"])
      .execute();
  }
}

function commandKind(value: string): TurnCommandKind {
  if (
    value === "steer" ||
    value === "interrupt" ||
    value === "respond" ||
    value === "release" ||
    value === "stop"
  )
    return value;
  throw new Error(`Invalid persisted turn command kind '${value}'`);
}
