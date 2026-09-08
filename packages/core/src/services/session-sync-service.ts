import type { DB } from "@catamorphic/db";
import { getTracer, withSpan } from "@catamorphic/otel";
import { type Kysely, type Selectable, sql } from "kysely";
import type { Identity } from "../identity.js";
import { assertAgentSessionAccess } from "./agent-session-access.js";
import { requireTenantProject } from "./projects-service.js";

type SyncIntentRow = Selectable<DB["session_sync_intents"]>;

export interface SessionSyncIntent {
  id: string;
  projectId: string;
  sessionId: string;
  destinationKey: string;
  authorityRevision: number;
  messageCount: number;
  attemptCount: number;
}

export interface SessionSyncStatus {
  state: "pending" | "leased" | "acknowledged" | "diverged";
  desiredAuthorityRevision: number;
  desiredMessageCount: number;
  acknowledgedAuthorityRevision: number | null;
  acknowledgedMessageCount: number | null;
  attemptCount: number;
  lastError: string | null;
  updatedAt: string;
}

export class SessionSyncLeaseError extends Error {
  constructor(readonly intentId: string) {
    super(
      `Session sync intent '${intentId}' is not owned by this worker lease`,
    );
    this.name = "SessionSyncLeaseError";
  }
}

export class SessionSyncWatermarkError extends Error {
  constructor(readonly intentId: string) {
    super(`Session sync intent '${intentId}' destination watermark changed`);
    this.name = "SessionSyncWatermarkError";
  }
}

const tracer = getTracer("@catamorphic/core");

/** Durable host-neutral outbox. Hosts resolve destination keys and transport. */
export class SessionSyncService {
  constructor(private readonly db: Kysely<DB>) {}

  async enqueue(args: {
    identity: Identity;
    projectId: string;
    sessionId: string;
    destinationKey: string;
  }): Promise<SessionSyncStatus> {
    return withSpan(
      {
        tracer,
        name: "agent.session.sync.enqueue",
        attributes: {
          "catamorphic.project.id": args.projectId,
          "catamorphic.agent.session.id": args.sessionId,
        },
      },
      async () => {
        await requireTenantProject(
          this.db,
          args.identity.tenantId,
          args.projectId,
        );
        const snapshot = await this.db
          .selectFrom("agent_sessions")
          .leftJoin(
            "agent_messages",
            "agent_messages.session_id",
            "agent_sessions.id",
          )
          .select([
            "agent_sessions.external_user_id",
            "agent_sessions.agent_id",
            "agent_sessions.authority_revision",
            this.db.fn.count("agent_messages.id").as("message_count"),
          ])
          .where("agent_sessions.id", "=", args.sessionId)
          .where("agent_sessions.project_id", "=", args.projectId)
          .groupBy([
            "agent_sessions.id",
            "agent_sessions.external_user_id",
            "agent_sessions.agent_id",
            "agent_sessions.authority_revision",
          ])
          .executeTakeFirst();
        if (!snapshot)
          throw new Error(`Agent session '${args.sessionId}' not found`);
        assertAgentSessionAccess({
          identity: args.identity,
          projectId: args.projectId,
          externalUserId: snapshot.external_user_id,
          agentId: snapshot.agent_id,
        });
        const now = new Date();
        const row = await this.db
          .insertInto("session_sync_intents")
          .values({
            project_id: args.projectId,
            session_id: args.sessionId,
            destination_key: args.destinationKey,
            desired_authority_revision: snapshot.authority_revision,
            desired_message_count: Number(snapshot.message_count),
          })
          .onConflict((conflict) =>
            conflict.columns(["session_id", "destination_key"]).doUpdateSet({
              desired_authority_revision: snapshot.authority_revision,
              desired_message_count: Number(snapshot.message_count),
              status: "pending",
              next_attempt_at: now,
              lease_owner: null,
              lease_expires_at: null,
              last_error: null,
              updated_at: now,
            }),
          )
          .returningAll()
          .executeTakeFirstOrThrow();
        return mapStatus(row);
      },
    );
  }

  async claimDue(args: {
    workerId: string;
    limit: number;
    leaseMs: number;
  }): Promise<SessionSyncIntent[]> {
    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + args.leaseMs);
    return this.db.transaction().execute(async (transaction) => {
      const candidates = await transaction
        .selectFrom("session_sync_intents")
        .select("id")
        .where((expression) =>
          expression.or([
            expression.and([
              expression("status", "=", "pending"),
              expression("next_attempt_at", "<=", now),
            ]),
            expression.and([
              expression("status", "=", "leased"),
              expression("lease_expires_at", "<=", now),
            ]),
          ]),
        )
        .orderBy("next_attempt_at", "asc")
        .limit(args.limit)
        .forUpdate()
        .skipLocked()
        .execute();
      if (candidates.length === 0) return [];
      const rows = await transaction
        .updateTable("session_sync_intents")
        .set({
          status: "leased",
          lease_owner: args.workerId,
          lease_expires_at: leaseExpiresAt,
          attempt_count: sql<number>`attempt_count + 1`,
          updated_at: now,
        })
        .where(
          "id",
          "in",
          candidates.map((candidate) => candidate.id),
        )
        .returningAll()
        .execute();
      return rows.map(mapIntent);
    });
  }

  async acknowledge(args: {
    intentId: string;
    workerId: string;
    authorityRevision: number;
    messageCount: number;
  }): Promise<void> {
    const row = await this.db
      .selectFrom("session_sync_intents")
      .selectAll()
      .where("id", "=", args.intentId)
      .executeTakeFirstOrThrow();
    if (row.status !== "leased" || row.lease_owner !== args.workerId) {
      throw new SessionSyncLeaseError(args.intentId);
    }
    if (
      Number(row.desired_authority_revision) !== args.authorityRevision ||
      row.desired_message_count !== args.messageCount
    ) {
      throw new SessionSyncWatermarkError(args.intentId);
    }
    const result = await this.db
      .updateTable("session_sync_intents")
      .set({
        status: "acknowledged",
        acknowledged_authority_revision: args.authorityRevision,
        acknowledged_message_count: args.messageCount,
        lease_owner: null,
        lease_expires_at: null,
        last_error: null,
        updated_at: new Date(),
      })
      .where("id", "=", args.intentId)
      .where("status", "=", "leased")
      .where("lease_owner", "=", args.workerId)
      .executeTakeFirst();
    if (result.numUpdatedRows === 0n) {
      throw new SessionSyncLeaseError(args.intentId);
    }
  }

  async fail(args: {
    intentId: string;
    workerId: string;
    error: string;
    retryAt: Date;
  }): Promise<void> {
    const result = await this.db
      .updateTable("session_sync_intents")
      .set({
        status: "pending",
        next_attempt_at: args.retryAt,
        lease_owner: null,
        lease_expires_at: null,
        last_error: args.error,
        updated_at: new Date(),
      })
      .where("id", "=", args.intentId)
      .where("status", "=", "leased")
      .where("lease_owner", "=", args.workerId)
      .executeTakeFirst();
    if (result.numUpdatedRows === 0n) {
      throw new SessionSyncLeaseError(args.intentId);
    }
  }

  async markDiverged(args: {
    intentId: string;
    workerId: string;
    error: string;
  }): Promise<void> {
    const result = await this.db
      .updateTable("session_sync_intents")
      .set({
        status: "diverged",
        lease_owner: null,
        lease_expires_at: null,
        last_error: args.error,
        updated_at: new Date(),
      })
      .where("id", "=", args.intentId)
      .where("status", "=", "leased")
      .where("lease_owner", "=", args.workerId)
      .executeTakeFirst();
    if (result.numUpdatedRows === 0n) {
      throw new SessionSyncLeaseError(args.intentId);
    }
  }

  async status(args: {
    identity: Identity;
    projectId: string;
    sessionId: string;
    destinationKey: string;
  }): Promise<SessionSyncStatus | null> {
    await requireTenantProject(this.db, args.identity.tenantId, args.projectId);
    const row = await this.db
      .selectFrom("session_sync_intents")
      .innerJoin(
        "agent_sessions",
        "agent_sessions.id",
        "session_sync_intents.session_id",
      )
      .selectAll("session_sync_intents")
      .select(["agent_sessions.external_user_id", "agent_sessions.agent_id"])
      .where("session_sync_intents.project_id", "=", args.projectId)
      .where("session_sync_intents.session_id", "=", args.sessionId)
      .where("session_sync_intents.destination_key", "=", args.destinationKey)
      .executeTakeFirst();
    if (!row) return null;
    assertAgentSessionAccess({
      identity: args.identity,
      projectId: args.projectId,
      externalUserId: row.external_user_id,
      agentId: row.agent_id,
    });
    return mapStatus(row);
  }
}

function mapIntent(row: SyncIntentRow): SessionSyncIntent {
  return {
    id: row.id,
    projectId: row.project_id,
    sessionId: row.session_id,
    destinationKey: row.destination_key,
    authorityRevision: Number(row.desired_authority_revision),
    messageCount: row.desired_message_count,
    attemptCount: row.attempt_count,
  };
}

function mapStatus(row: SyncIntentRow): SessionSyncStatus {
  return {
    state: parseState(row.status),
    desiredAuthorityRevision: Number(row.desired_authority_revision),
    desiredMessageCount: row.desired_message_count,
    acknowledgedAuthorityRevision:
      row.acknowledged_authority_revision === null
        ? null
        : Number(row.acknowledged_authority_revision),
    acknowledgedMessageCount: row.acknowledged_message_count,
    attemptCount: row.attempt_count,
    lastError: row.last_error,
    updatedAt: row.updated_at.toISOString(),
  };
}

function parseState(value: string): SessionSyncStatus["state"] {
  if (
    value === "pending" ||
    value === "leased" ||
    value === "acknowledged" ||
    value === "diverged"
  ) {
    return value;
  }
  throw new Error(`Invalid session sync status '${value}'`);
}
