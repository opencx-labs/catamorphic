import { randomUUID } from "node:crypto";
import type { DB } from "@catamorphic/db";
import type {
  ToolPermissionDecision,
  ToolPermissionHandler,
  ToolPermissionRequest,
} from "@catamorphic/sandbox";
import { type Kysely, sql } from "kysely";
import { z } from "zod";
import type { Identity } from "../identity.js";
import {
  AgentRequestAlreadyResolvedError,
  AgentRuntimeRequestsService,
} from "./agent-runtime-requests-service.js";
import type {
  PendingToolPermission,
  ToolPermissionChannel,
} from "./tool-permission-broker.js";

const payloadSchema = z.object({
  kind: z.literal("approval"),
  requestId: z.string(),
  sessionId: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
  origin: z.object({ displayName: z.string().optional() }),
  toolRequest: z.object({
    sessionId: z.string().optional(),
    server: z.string(),
    tool: z.string(),
    description: z.string().optional(),
    input: z.record(z.string(), z.unknown()),
    annotations: z
      .object({
        readOnlyHint: z.boolean().optional(),
        destructiveHint: z.boolean().optional(),
      })
      .optional(),
  }),
});
const responseSchema = z.object({
  kind: z.literal("approval"),
  decision: z.enum(["approved", "denied"]),
  remember: z.literal("always").optional(),
});

/** Uses the ordinary durable runtime request, so any API instance can answer. */
export class DurableToolPermissionBroker implements ToolPermissionChannel {
  private readonly requests: AgentRuntimeRequestsService;
  constructor(
    private readonly db: Kysely<DB>,
    private readonly timeoutMs = 300_000,
  ) {
    this.requests = new AgentRuntimeRequestsService(db);
  }
  handlerFor(agentLabel?: string): ToolPermissionHandler {
    return (request) => this.ask({ request, agentLabel });
  }
  private async ask(args: {
    request: ToolPermissionRequest;
    agentLabel?: string;
  }): Promise<ToolPermissionDecision> {
    const sessionId = args.request.sessionId;
    if (!sessionId) return { decision: "deny" };
    const identity = await this.owner(sessionId);
    const turn = await this.db
      .selectFrom("agent_turns")
      .select("id")
      .where("session_id", "=", sessionId)
      .where("status", "=", "running")
      .executeTakeFirst();
    const requestId = randomUUID();
    const expiresAt = new Date(Date.now() + this.timeoutMs).toISOString();
    await this.requests.create({
      identity,
      request: {
        kind: "approval",
        requestId,
        sessionId,
        ...(turn ? { turnId: turn.id } : {}),
        status: "pending",
        createdAt: new Date().toISOString(),
        expiresAt,
        origin: {
          kind: "tool",
          id: args.request.server,
          displayName: args.agentLabel,
        },
        title: args.request.tool,
        description: args.request.description,
        approval: { action: args.request.tool },
        toolRequest: args.request,
      },
    });
    while (Date.now() < Date.parse(expiresAt)) {
      if (turn) {
        const active = await this.db
          .selectFrom("agent_turns")
          .select("id")
          .where("id", "=", turn.id)
          .where("status", "=", "running")
          .where("cancellation_requested_at", "is", null)
          .where("lease_expires_at", ">", sql<Date>`now()`)
          .executeTakeFirst();
        if (!active) {
          await this.db
            .updateTable("agent_runtime_requests")
            .set({ status: "cancelled", updated_at: new Date() })
            .where("request_id", "=", requestId)
            .where("status", "=", "pending")
            .execute();
          return { decision: "deny" };
        }
      }
      const row = await this.db
        .selectFrom("agent_runtime_requests")
        .select(["status", "response"])
        .where("session_id", "=", sessionId)
        .where("request_id", "=", requestId)
        .executeTakeFirst();
      if (!row || row.status === "cancelled" || row.status === "expired")
        return { decision: "deny" };
      if (row.status === "resolved") {
        const response = responseSchema.parse(row.response);
        return response.decision === "approved"
          ? {
              decision: "allow",
              ...(response.remember ? { remember: response.remember } : {}),
            }
          : { decision: "deny" };
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    await this.requests.expire({ identity, sessionId });
    return { decision: "deny" };
  }
  async list(sessionId?: string): Promise<PendingToolPermission[]> {
    if (!sessionId) return [];
    const rows = await this.db
      .selectFrom("agent_runtime_requests")
      .select("payload")
      .where("session_id", "=", sessionId)
      .where("kind", "=", "approval")
      .where("status", "=", "pending")
      .where("expires_at", ">", sql<Date>`now()`)
      .orderBy("created_at")
      .execute();
    return rows.flatMap((row) => {
      const parsed = payloadSchema.safeParse(row.payload);
      return parsed.success ? [pending(parsed.data)] : [];
    });
  }
  async get(id: string): Promise<PendingToolPermission | undefined> {
    const row = await this.db
      .selectFrom("agent_runtime_requests")
      .select("payload")
      .where("request_id", "=", id)
      .where("kind", "=", "approval")
      .where("status", "=", "pending")
      .where("expires_at", ">", sql<Date>`now()`)
      .executeTakeFirst();
    const parsed = payloadSchema.safeParse(row?.payload);
    return parsed.success ? pending(parsed.data) : undefined;
  }
  async answer(
    id: string,
    decision: ToolPermissionDecision,
    identity?: Identity,
  ): Promise<boolean> {
    if (!identity) return false;
    const request = await this.get(id);
    if (!request?.sessionId) return false;
    try {
      await this.requests.respond({
        identity,
        sessionId: request.sessionId,
        requestId: id,
        response: {
          kind: "approval",
          decision: decision.decision === "allow" ? "approved" : "denied",
          ...(decision.decision === "allow" && decision.remember
            ? { remember: decision.remember }
            : {}),
        },
      });
      return true;
    } catch (error) {
      if (error instanceof AgentRequestAlreadyResolvedError) return false;
      throw error;
    }
  }
  private async owner(sessionId: string) {
    const session = await this.db
      .selectFrom("agent_sessions")
      .innerJoin("projects", "projects.id", "agent_sessions.project_id")
      .select(["projects.tenant_id", "agent_sessions.external_user_id"])
      .where("agent_sessions.id", "=", sessionId)
      .executeTakeFirstOrThrow();
    return {
      tenantId: session.tenant_id,
      externalUserId: session.external_user_id,
    };
  }
}

function pending(
  payload: z.infer<typeof payloadSchema>,
): PendingToolPermission {
  return {
    id: payload.requestId,
    sessionId: payload.sessionId,
    agentLabel: payload.origin.displayName,
    request: payload.toolRequest,
    createdAt: payload.createdAt,
    expiresAt: payload.expiresAt,
  };
}
