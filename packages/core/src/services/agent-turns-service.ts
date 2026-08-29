import { randomUUID } from "node:crypto";
import type { DB, JsonObject } from "@catamorphic/db";
import { getTracer, withSpan } from "@catamorphic/otel";
import { type Kysely, sql, type Transaction } from "kysely";

export type SessionDeliveryMode = "message_only" | "next_turn" | "interrupt";

export type SessionMessageAuthor =
  | { kind: "user"; externalUserId: string }
  | { kind: "agent"; sessionId: string; agentId: string | null }
  | { kind: "workflow"; runId: string; workflowName: string }
  | { kind: "watcher"; watcherId: string; runId?: string }
  | { kind: "system"; code: string };

export type AgentTurnStatus =
  | "queued"
  | "held"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface AgentTurn {
  id: string;
  sessionId: string;
  messageId: string;
  resultMessageId: string | null;
  deliveryMode: Exclude<SessionDeliveryMode, "message_only">;
  status: AgentTurnStatus;
  priority: number;
  attempt: number;
  leaseOwner: string | null;
  leaseToken: string | null;
  leaseExpiresAt: string | null;
  createdAt: string;
}

export interface SessionDeliveryReceipt {
  messageId: string;
  turnId: string | null;
  mode: SessionDeliveryMode;
  created: boolean;
}

export interface PendingSessionTurn {
  id: string;
  messageId: string;
  content: string;
  metadata: JsonObject | null;
  deliveryMode: Exclude<SessionDeliveryMode, "message_only">;
  status: "queued" | "held" | "running";
  createdAt: string;
}

const tracer = getTracer("@catamorphic/core");

function jsonAuthor(author: SessionMessageAuthor): JsonObject {
  return JSON.parse(JSON.stringify(author));
}

function parseDeliveryMode(value: string): SessionDeliveryMode {
  if (
    value !== "message_only" &&
    value !== "next_turn" &&
    value !== "interrupt"
  ) {
    throw new Error(`Invalid persisted session delivery mode '${value}'`);
  }
  return value;
}

function mapTurn(row: {
  id: string;
  session_id: string;
  message_id: string;
  result_message_id: string | null;
  delivery_mode: string;
  status: string;
  priority: number;
  attempt: number;
  lease_owner: string | null;
  lease_token: string | null;
  lease_expires_at: Date | null;
  created_at: Date;
}): AgentTurn {
  if (row.delivery_mode !== "next_turn" && row.delivery_mode !== "interrupt") {
    throw new Error(`Invalid persisted agent turn mode '${row.delivery_mode}'`);
  }
  if (
    row.status !== "queued" &&
    row.status !== "held" &&
    row.status !== "running" &&
    row.status !== "completed" &&
    row.status !== "failed" &&
    row.status !== "cancelled"
  ) {
    throw new Error(`Invalid persisted agent turn status '${row.status}'`);
  }
  return {
    id: row.id,
    sessionId: row.session_id,
    messageId: row.message_id,
    resultMessageId: row.result_message_id,
    deliveryMode: row.delivery_mode,
    status: row.status,
    priority: row.priority,
    attempt: row.attempt,
    leaseOwner: row.lease_owner,
    leaseToken: row.lease_token,
    leaseExpiresAt: row.lease_expires_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  };
}

/** Durable inbox and serialized turn queue for agent sessions (ADR 0074). */
export class AgentTurnsService {
  constructor(private readonly db: Kysely<DB>) {}

  async deliver(input: {
    sessionId: string;
    content: string;
    author: SessionMessageAuthor;
    mode: SessionDeliveryMode;
    idempotencyKey?: string;
    metadata?: JsonObject;
    transaction?: Transaction<DB>;
  }): Promise<SessionDeliveryReceipt> {
    return withSpan(
      {
        tracer,
        name: "agent.session.deliver",
        attributes: {
          "catamorphic.agent.session.id": input.sessionId,
          "catamorphic.agent.message.author": input.author.kind,
          "catamorphic.agent.delivery.mode": input.mode,
        },
      },
      () => this.deliverInner(input),
    );
  }

  private async deliverInner(input: {
    sessionId: string;
    content: string;
    author: SessionMessageAuthor;
    mode: SessionDeliveryMode;
    idempotencyKey?: string;
    metadata?: JsonObject;
    transaction?: Transaction<DB>;
  }): Promise<SessionDeliveryReceipt> {
    if (!input.content.trim())
      throw new Error("Session message cannot be empty");
    const deliver = async (trx: Transaction<DB>) => {
      if (input.idempotencyKey) {
        const existing = await trx
          .selectFrom("agent_messages")
          .leftJoin(
            "agent_turns",
            "agent_turns.message_id",
            "agent_messages.id",
          )
          .select([
            "agent_messages.id as message_id",
            "agent_messages.delivery_mode",
            "agent_turns.id as turn_id",
          ])
          .where("agent_messages.session_id", "=", input.sessionId)
          .where("agent_messages.idempotency_key", "=", input.idempotencyKey)
          .executeTakeFirst();
        if (existing) {
          return {
            messageId: existing.message_id,
            turnId: existing.turn_id,
            mode: parseDeliveryMode(existing.delivery_mode),
            created: false,
          };
        }
      }

      const inserted = await trx
        .insertInto("agent_messages")
        .values({
          session_id: input.sessionId,
          role: input.author.kind === "system" ? "system" : "user",
          content: input.content,
          author_kind: input.author.kind,
          author_payload: jsonAuthor(input.author),
          delivery_mode: input.mode,
          idempotency_key: input.idempotencyKey ?? null,
          metadata: input.metadata ?? null,
        })
        .onConflict((conflict) =>
          conflict
            .columns(["session_id", "idempotency_key"])
            .where("idempotency_key", "is not", null)
            .doNothing(),
        )
        .returning("id")
        .executeTakeFirst();

      if (!inserted) {
        const existing = await trx
          .selectFrom("agent_messages")
          .leftJoin(
            "agent_turns",
            "agent_turns.message_id",
            "agent_messages.id",
          )
          .select([
            "agent_messages.id as message_id",
            "agent_messages.delivery_mode",
            "agent_turns.id as turn_id",
          ])
          .where("agent_messages.session_id", "=", input.sessionId)
          .where(
            "agent_messages.idempotency_key",
            "=",
            input.idempotencyKey ?? "",
          )
          .executeTakeFirstOrThrow();
        return {
          messageId: existing.message_id,
          turnId: existing.turn_id,
          mode: parseDeliveryMode(existing.delivery_mode),
          created: false,
        };
      }

      if (input.mode === "message_only") {
        return {
          messageId: inserted.id,
          turnId: null,
          mode: input.mode,
          created: true,
        };
      }

      const turn = await trx
        .insertInto("agent_turns")
        .values({
          session_id: input.sessionId,
          message_id: inserted.id,
          delivery_mode: input.mode,
          priority: input.mode === "interrupt" ? 100 : 0,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      return {
        messageId: inserted.id,
        turnId: turn.id,
        mode: input.mode,
        created: true,
      };
    };
    return input.transaction
      ? deliver(input.transaction)
      : this.db.transaction().execute(deliver);
  }

  async listPending(input: { sessionId: string }): Promise<AgentTurn[]> {
    const rows = await this.db
      .selectFrom("agent_turns")
      .selectAll()
      .where("session_id", "=", input.sessionId)
      .where("status", "in", ["queued", "held", "running"])
      .orderBy("priority", "desc")
      .orderBy("created_at")
      .execute();
    return rows.map(mapTurn);
  }

  async listPendingMessages(input: {
    sessionId: string;
  }): Promise<PendingSessionTurn[]> {
    const rows = await this.db
      .selectFrom("agent_turns")
      .innerJoin(
        "agent_messages",
        "agent_messages.id",
        "agent_turns.message_id",
      )
      .select([
        "agent_turns.id",
        "agent_turns.message_id",
        "agent_turns.delivery_mode",
        "agent_turns.status",
        "agent_turns.created_at",
        "agent_messages.content",
        "agent_messages.metadata",
      ])
      .where("agent_turns.session_id", "=", input.sessionId)
      .where("agent_turns.status", "in", ["queued", "held", "running"])
      .orderBy("agent_turns.priority", "desc")
      .orderBy("agent_turns.created_at")
      .execute();
    return rows.map((row) => {
      if (
        row.delivery_mode !== "next_turn" &&
        row.delivery_mode !== "interrupt"
      ) {
        throw new Error(`Invalid queued turn mode '${row.delivery_mode}'`);
      }
      if (
        row.status !== "queued" &&
        row.status !== "held" &&
        row.status !== "running"
      ) {
        throw new Error(`Invalid pending turn status '${row.status}'`);
      }
      return {
        id: row.id,
        messageId: row.message_id,
        content: row.content,
        metadata: row.metadata as JsonObject | null,
        deliveryMode: row.delivery_mode,
        status: row.status,
        createdAt: row.created_at.toISOString(),
      };
    });
  }

  async updateQueued(input: {
    turnId: string;
    sessionId: string;
    content?: string;
    metadata?: JsonObject;
    held?: boolean;
  }): Promise<boolean> {
    if (input.content !== undefined && !input.content.trim())
      throw new Error("Session message cannot be empty");
    return this.db.transaction().execute(async (trx) => {
      const turn = await trx
        .selectFrom("agent_turns")
        .select(["message_id", "status"])
        .where("id", "=", input.turnId)
        .where("session_id", "=", input.sessionId)
        .where("status", "in", ["queued", "held"])
        .forUpdate()
        .executeTakeFirst();
      if (!turn) return false;
      if (input.content !== undefined || input.metadata !== undefined) {
        await trx
          .updateTable("agent_messages")
          .set({
            ...(input.content !== undefined ? { content: input.content } : {}),
            ...(input.metadata ? { metadata: input.metadata } : {}),
          })
          .where("id", "=", turn.message_id)
          .execute();
      }
      if (input.held !== undefined) {
        await trx
          .updateTable("agent_turns")
          .set({
            status: input.held ? "held" : "queued",
            updated_at: new Date(),
          })
          .where("id", "=", input.turnId)
          .execute();
      }
      return true;
    });
  }

  async promoteQueued(input: {
    turnId: string;
    sessionId: string;
  }): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      const turn = await trx
        .updateTable("agent_turns")
        .set({
          delivery_mode: "interrupt",
          priority: 100,
          status: "queued",
          updated_at: new Date(),
        })
        .where("id", "=", input.turnId)
        .where("session_id", "=", input.sessionId)
        .where("status", "in", ["queued", "held"])
        .returning("message_id")
        .executeTakeFirst();
      if (!turn) return false;
      await trx
        .updateTable("agent_messages")
        .set({ delivery_mode: "interrupt" })
        .where("id", "=", turn.message_id)
        .execute();
      return true;
    });
  }

  async cancelQueued(input: {
    turnId: string;
    sessionId: string;
  }): Promise<boolean> {
    const result = await this.db
      .updateTable("agent_turns")
      .set({
        status: "cancelled",
        completed_at: new Date(),
        updated_at: new Date(),
      })
      .where("id", "=", input.turnId)
      .where("session_id", "=", input.sessionId)
      .where("status", "in", ["queued", "held"])
      .executeTakeFirst();
    return result.numUpdatedRows === 1n;
  }

  async claimNext(input: {
    workerId: string;
    leaseSeconds?: number;
  }): Promise<AgentTurn | null> {
    return this.claim(input);
  }

  async claimNextForSession(input: {
    workerId: string;
    sessionId: string;
    leaseSeconds?: number;
  }): Promise<AgentTurn | null> {
    return this.claim(input);
  }

  private async claim(input: {
    workerId: string;
    sessionId?: string;
    leaseSeconds?: number;
  }): Promise<AgentTurn | null> {
    const leaseToken = randomUUID();
    const leaseSeconds = input.leaseSeconds ?? 60;
    return this.db.transaction().execute(async (trx) => {
      const candidate = await trx
        .selectFrom("agent_turns as turn")
        .selectAll("turn")
        .where("turn.status", "=", "queued")
        .where("turn.available_at", "<=", new Date())
        .$if(input.sessionId !== undefined, (query) =>
          query.where("turn.session_id", "=", input.sessionId ?? ""),
        )
        .where(({ exists, not, selectFrom }) =>
          not(
            exists(
              selectFrom("agent_turns as active")
                .select("active.id")
                .whereRef("active.session_id", "=", "turn.session_id")
                .where("active.status", "=", "running"),
            ),
          ),
        )
        .where(({ exists, not, or, and, selectFrom }) =>
          not(
            exists(
              selectFrom("agent_turns as ahead")
                .select("ahead.id")
                .whereRef("ahead.session_id", "=", "turn.session_id")
                .where("ahead.status", "=", "queued")
                .where("ahead.available_at", "<=", new Date())
                .where(
                  or([
                    sql<boolean>`ahead.priority > turn.priority`,
                    and([
                      sql<boolean>`ahead.priority = turn.priority`,
                      sql<boolean>`ahead.created_at < turn.created_at`,
                    ]),
                  ]),
                ),
            ),
          ),
        )
        .orderBy("turn.priority", "desc")
        .orderBy("turn.created_at")
        .forUpdate()
        .skipLocked()
        .executeTakeFirst();
      if (!candidate) return null;

      const row = await trx
        .updateTable("agent_turns")
        .set(({ ref }) => ({
          status: "running",
          lease_owner: input.workerId,
          lease_token: leaseToken,
          lease_expires_at: sql`now() + (${leaseSeconds} * interval '1 second')`,
          started_at: sql`coalesce(${ref("started_at")}, now())`,
          attempt: sql`${ref("attempt")} + 1`,
          updated_at: new Date(),
        }))
        .where("id", "=", candidate.id)
        .where("status", "=", "queued")
        .returningAll()
        .executeTakeFirst();
      return row ? mapTurn(row) : null;
    });
  }

  async complete(input: {
    turnId: string;
    leaseToken: string;
    resultMessageId: string;
  }): Promise<boolean> {
    const result = await this.db
      .updateTable("agent_turns")
      .set({
        status: "completed",
        result_message_id: input.resultMessageId,
        completed_at: new Date(),
        lease_owner: null,
        lease_token: null,
        lease_expires_at: null,
        updated_at: new Date(),
      })
      .where("id", "=", input.turnId)
      .where("status", "=", "running")
      .where("lease_token", "=", input.leaseToken)
      .executeTakeFirst();
    return result.numUpdatedRows === 1n;
  }

  async fail(input: {
    turnId: string;
    leaseToken: string;
    error: string;
  }): Promise<boolean> {
    const result = await this.db
      .updateTable("agent_turns")
      .set({
        status: "failed",
        error: input.error,
        completed_at: new Date(),
        lease_owner: null,
        lease_token: null,
        lease_expires_at: null,
        updated_at: new Date(),
      })
      .where("id", "=", input.turnId)
      .where("status", "=", "running")
      .where("lease_token", "=", input.leaseToken)
      .executeTakeFirst();
    return result.numUpdatedRows === 1n;
  }

  async requeueExpired(): Promise<number> {
    const result = await this.db
      .updateTable("agent_turns")
      .set({
        status: "queued",
        lease_owner: null,
        lease_token: null,
        lease_expires_at: null,
        available_at: new Date(),
        updated_at: new Date(),
      })
      .where("status", "=", "running")
      .where("lease_expires_at", "<", new Date())
      .executeTakeFirst();
    return Number(result.numUpdatedRows);
  }

  async messageForTurn(input: { turnId: string }): Promise<{
    content: string;
    metadata: JsonObject | null;
    author: SessionMessageAuthor;
  }> {
    const row = await this.db
      .selectFrom("agent_turns")
      .innerJoin(
        "agent_messages",
        "agent_messages.id",
        "agent_turns.message_id",
      )
      .select([
        "agent_messages.content",
        "agent_messages.metadata",
        "agent_messages.author_kind",
        "agent_messages.author_payload",
      ])
      .where("agent_turns.id", "=", input.turnId)
      .executeTakeFirstOrThrow();
    return {
      content: row.content,
      metadata: row.metadata as JsonObject | null,
      author: parseSessionMessageAuthor(row.author_kind, row.author_payload),
    };
  }
}

export function parseSessionMessageAuthor(
  kind: string,
  payload: unknown,
): SessionMessageAuthor {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Agent turn message has an invalid author payload");
  }
  const author = payload as Record<string, unknown>;
  if (kind === "user" && typeof author.externalUserId === "string") {
    return { kind: "user", externalUserId: author.externalUserId };
  }
  if (
    kind === "agent" &&
    typeof author.sessionId === "string" &&
    (typeof author.agentId === "string" || author.agentId === null)
  ) {
    return {
      kind: "agent",
      sessionId: author.sessionId,
      agentId: author.agentId,
    };
  }
  if (
    kind === "workflow" &&
    typeof author.runId === "string" &&
    typeof author.workflowName === "string"
  ) {
    return {
      kind: "workflow",
      runId: author.runId,
      workflowName: author.workflowName,
    };
  }
  if (
    kind === "watcher" &&
    typeof author.watcherId === "string" &&
    (author.runId === undefined || typeof author.runId === "string")
  ) {
    return {
      kind: "watcher",
      watcherId: author.watcherId,
      ...(typeof author.runId === "string" ? { runId: author.runId } : {}),
    };
  }
  if (kind === "system" && typeof author.code === "string") {
    return { kind: "system", code: author.code };
  }
  throw new Error("Agent turn message has an invalid author payload");
}
