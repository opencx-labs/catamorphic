import type { DB, Json } from "@catamorphic/db";
import { getTracer, withSpan } from "@catamorphic/otel";
import type {
  AgentRuntimeRequest,
  AgentRuntimeRequestResponse,
} from "@catamorphic/sandbox";
import { type Kysely, sql, type Transaction } from "kysely";
import type { Identity } from "../identity.js";
import { requireRuntimeSession } from "./agent-runtime-events-service.js";
import {
  canonicalRuntimeJson,
  sameCanonicalRuntimeJson,
} from "./agent-runtime-json.js";

const tracer = getTracer("@catamorphic/core");

export class AgentRequestAlreadyResolvedError extends Error {
  constructor(readonly requestId: string) {
    super(`Agent runtime request '${requestId}' is no longer pending`);
    this.name = "AgentRequestAlreadyResolvedError";
  }
}

export class AgentRuntimeRequestNotFoundError extends Error {
  constructor(readonly requestId: string) {
    super(`Agent runtime request '${requestId}' not found`);
    this.name = "AgentRuntimeRequestNotFoundError";
  }
}

export class AgentRuntimeRequestConflictError extends Error {
  constructor(readonly requestId: string) {
    super(
      `Agent runtime request '${requestId}' was reused with different data`,
    );
    this.name = "AgentRuntimeRequestConflictError";
  }
}

/** Durable approval, question, and elicitation requests for an agent session. */
export class AgentRuntimeRequestsService {
  constructor(private readonly db: Kysely<DB>) {}

  async create(args: {
    identity: Identity;
    request: AgentRuntimeRequest;
  }): Promise<{ inserted: boolean }> {
    if (args.request.status !== "pending") {
      throw new AgentRuntimeRequestConflictError(args.request.requestId);
    }
    return this.db.transaction().execute(async (trx) => {
      await requireRuntimeSession({
        db: trx,
        identity: args.identity,
        sessionId: args.request.sessionId,
        lock: true,
      });
      const payload = canonicalRuntimeJson(args.request);
      const existing = await trx
        .selectFrom("agent_runtime_requests")
        .select("payload")
        .where("session_id", "=", args.request.sessionId)
        .where("request_id", "=", args.request.requestId)
        .forUpdate()
        .executeTakeFirst();
      if (existing) {
        if (sameCanonicalRuntimeJson(existing.payload, payload)) {
          return { inserted: false };
        }
        throw new AgentRuntimeRequestConflictError(args.request.requestId);
      }
      await trx
        .insertInto("agent_runtime_requests")
        .values({
          session_id: args.request.sessionId,
          request_id: args.request.requestId,
          turn_id: args.request.turnId ?? null,
          kind: args.request.kind,
          payload,
          status: "pending",
          expires_at: args.request.expiresAt ?? null,
          created_at: args.request.createdAt,
        })
        .execute();
      return { inserted: true };
    });
  }

  async respond(args: {
    identity: Identity;
    sessionId: string;
    requestId: string;
    response: AgentRuntimeRequestResponse;
  }): Promise<void> {
    return withSpan(
      {
        tracer,
        name: "agent.runtime.request.respond",
        attributes: { "catamorphic.session.id": args.sessionId },
      },
      async (span) => {
        await this.db.transaction().execute(async (trx) => {
          await requireRuntimeSession({
            db: trx,
            identity: args.identity,
            sessionId: args.sessionId,
            lock: true,
          });
          const request = await selectRequestForUpdate({
            trx,
            sessionId: args.sessionId,
            requestId: args.requestId,
          });
          if (!request)
            throw new AgentRuntimeRequestNotFoundError(args.requestId);
          if (request.status !== "pending") {
            throw new AgentRequestAlreadyResolvedError(args.requestId);
          }
          const stored = requestFromPayload(request.payload);
          if (stored.turnId) {
            span.setAttribute("catamorphic.agent.turn_id", stored.turnId);
          }
          if (stored.kind !== args.response.kind) {
            throw new AgentRuntimeRequestConflictError(args.requestId);
          }
          const resolved = await trx
            .updateTable("agent_runtime_requests")
            .set({
              status: "resolved",
              response: canonicalRuntimeJson(args.response),
              resolved_by_external_user_id: args.identity.externalUserId,
              resolved_at: new Date(),
              updated_at: new Date(),
              revision: sql<number>`revision + 1`,
            })
            .where("session_id", "=", args.sessionId)
            .where("request_id", "=", args.requestId)
            .where("status", "=", "pending")
            .returning("request_id")
            .executeTakeFirst();
          if (!resolved) {
            throw new AgentRequestAlreadyResolvedError(args.requestId);
          }
        });
      },
    );
  }

  async expire(args: {
    identity: Identity;
    sessionId: string;
    now?: string;
  }): Promise<number> {
    return this.db.transaction().execute(async (trx) => {
      await requireRuntimeSession({
        db: trx,
        identity: args.identity,
        sessionId: args.sessionId,
        lock: true,
      });
      const expired = await trx
        .updateTable("agent_runtime_requests")
        .set({
          status: "expired",
          resolved_at: new Date(),
          updated_at: new Date(),
          revision: sql<number>`revision + 1`,
        })
        .where("session_id", "=", args.sessionId)
        .where("status", "=", "pending")
        .where("expires_at", "is not", null)
        .where("expires_at", "<=", args.now ? new Date(args.now) : new Date())
        .returning("request_id")
        .execute();
      return expired.length;
    });
  }

  async listPending(args: {
    identity: Identity;
    sessionId: string;
  }): Promise<AgentRuntimeRequest[]> {
    await requireRuntimeSession({
      db: this.db,
      identity: args.identity,
      sessionId: args.sessionId,
      lock: false,
    });
    const pending = await this.db
      .selectFrom("agent_runtime_requests")
      .select("payload")
      .where("session_id", "=", args.sessionId)
      .where("status", "=", "pending")
      .orderBy("created_at", "asc")
      .execute();
    return pending.map((request) => requestFromPayload(request.payload));
  }
}

async function selectRequestForUpdate(args: {
  trx: Transaction<DB>;
  sessionId: string;
  requestId: string;
}): Promise<{ payload: Json; request_id: string; status: string } | undefined> {
  return args.trx
    .selectFrom("agent_runtime_requests")
    .select(["payload", "request_id", "status"])
    .where("session_id", "=", args.sessionId)
    .where("request_id", "=", args.requestId)
    .forUpdate()
    .executeTakeFirst();
}

function requestFromPayload(payload: unknown): AgentRuntimeRequest {
  return JSON.parse(JSON.stringify(payload));
}
