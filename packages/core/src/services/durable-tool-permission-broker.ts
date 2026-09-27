import { randomUUID } from "node:crypto";
import type { DB } from "@catamorphic/db";
import type {
  ToolPermissionDecision,
  ToolPermissionHandler,
  ToolPermissionRequest,
} from "@catamorphic/sandbox";
import { type Kysely, sql } from "kysely";
import { z } from "zod";
import { type Identity, isProjectPrincipal } from "../identity.js";
import {
  AgentRequestAlreadyResolvedError,
  AgentRuntimeRequestsService,
} from "./agent-runtime-requests-service.js";
import type {
  PendingToolPermission,
  ToolPermissionChannel,
} from "./tool-permission-broker.js";
import { UserNotificationsService } from "./user-notifications-service.js";

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
  approvers: z.array(z.string()).optional(),
});
const responseSchema = z.object({
  kind: z.literal("approval"),
  decision: z.enum(["approved", "denied"]),
  remember: z.literal("always").optional(),
});
const approversSchema = z.object({
  members: z.array(z.string()).optional(),
  roles: z.array(z.string()).optional(),
});
const allocationApprovalsSchema = z.object({
  approvals: z.object({ waitMinutes: z.number() }).optional(),
});

/**
 * Uses the ordinary durable runtime request, so any API instance can answer.
 *
 * A chat someone is in answers its own asks. An unattended chat (a project
 * chat, or one an automation named approvers for) routes each ask to its
 * approvers through notifications and attention, and waits for them as long
 * as its Environment allows (ADR 0176).
 */
export class DurableToolPermissionBroker implements ToolPermissionChannel {
  private readonly requests: AgentRuntimeRequestsService;
  private readonly notifications: UserNotificationsService;
  private readonly timeoutMs: number;
  private readonly unattendedTimeoutMs: number;
  constructor(
    private readonly db: Kysely<DB>,
    options: {
      /** How long a person's own chat waits. Default five minutes. */
      timeoutMs?: number;
      /** How long an unattended chat waits for its approvers. Default 30 minutes. */
      unattendedTimeoutMs?: number;
      notifications?: UserNotificationsService;
    } = {},
  ) {
    this.requests = new AgentRuntimeRequestsService(db);
    this.notifications =
      options.notifications ?? new UserNotificationsService(db);
    this.timeoutMs = options.timeoutMs ?? 300_000;
    this.unattendedTimeoutMs = options.unattendedTimeoutMs ?? 30 * 60_000;
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
    const chat = await this.chat(sessionId);
    const identity: Identity = {
      tenantId: chat.tenantId,
      externalUserId: chat.owner,
    };
    const unattended = isProjectPrincipal(chat.owner) || chat.approvers;
    const approvers = unattended ? await this.approverIds(chat) : [];
    if (unattended && approvers.length === 0)
      return {
        decision: "deny",
        reason: `"${args.request.tool}" on ${args.request.server} needs a person's approval, and no one watches this chat. The automation that delivers into it can name approvers (members or project roles).`,
      };
    const timeoutMs = chat.waitMinutes
      ? chat.waitMinutes * 60_000
      : unattended
        ? this.unattendedTimeoutMs
        : this.timeoutMs;
    const turn = await this.db
      .selectFrom("agent_turns")
      .select("id")
      .where("session_id", "=", sessionId)
      .where("status", "=", "running")
      .executeTakeFirst();
    const requestId = randomUUID();
    const expiresAt = new Date(Date.now() + timeoutMs).toISOString();
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
        ...(approvers.length > 0 ? { approvers } : {}),
      },
    });
    await this.notify({ chat, sessionId, requestId, approvers, ...args });
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
    return {
      decision: "deny",
      reason: `No one answered the approval for "${args.request.tool}" within ${Math.round(timeoutMs / 60_000)} minutes, so it was not run.`,
    };
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
  private async chat(sessionId: string) {
    const session = await this.db
      .selectFrom("agent_sessions")
      .innerJoin("projects", "projects.id", "agent_sessions.project_id")
      .leftJoin(
        "execution_allocations",
        "execution_allocations.id",
        "agent_sessions.allocation_id",
      )
      .select([
        "projects.tenant_id",
        "agent_sessions.external_user_id",
        "agent_sessions.project_id",
        "agent_sessions.title",
        "agent_sessions.approvers",
        "execution_allocations.policy_snapshot",
      ])
      .where("agent_sessions.id", "=", sessionId)
      .executeTakeFirstOrThrow();
    const approvers = approversSchema.safeParse(session.approvers);
    const allocation = allocationApprovalsSchema.safeParse(
      session.policy_snapshot,
    );
    return {
      tenantId: session.tenant_id,
      owner: session.external_user_id,
      projectId: session.project_id,
      title: session.title,
      approvers:
        session.approvers !== null && approvers.success
          ? approvers.data
          : undefined,
      waitMinutes: allocation.success
        ? allocation.data.approvals?.waitMinutes
        : undefined,
    };
  }
  /** Named members, holders of named roles, and the chat's own person. */
  private async approverIds(
    chat: Awaited<ReturnType<DurableToolPermissionBroker["chat"]>>,
  ): Promise<string[]> {
    const roles = new Set(chat.approvers?.roles ?? []);
    const holders =
      roles.size === 0
        ? []
        : (
            await this.db
              .selectFrom("memberships")
              .select(["external_user_id", "roles"])
              .where("project_id", "=", chat.projectId)
              .execute()
          )
            .filter(
              (row) =>
                Array.isArray(row.roles) &&
                row.roles.some(
                  (role) => typeof role === "string" && roles.has(role),
                ),
            )
            .map((row) => row.external_user_id);
    return [
      ...new Set([
        ...(isProjectPrincipal(chat.owner) ? [] : [chat.owner]),
        ...(chat.approvers?.members ?? []),
        ...holders,
      ]),
    ].sort();
  }
  /** Each approver hears about it and finds the chat waiting for them. */
  private async notify(args: {
    chat: Awaited<ReturnType<DurableToolPermissionBroker["chat"]>>;
    sessionId: string;
    requestId: string;
    approvers: readonly string[];
    request: ToolPermissionRequest;
    agentLabel?: string;
  }): Promise<void> {
    const { chat } = args;
    for (const approver of args.approvers) {
      await this.db
        .insertInto("agent_session_views")
        .values({
          session_id: args.sessionId,
          tenant_id: chat.tenantId,
          external_user_id: approver,
          visibility: "promoted",
          previous_visibility: "promoted",
        })
        .onConflict((conflict) =>
          conflict
            .columns(["session_id", "tenant_id", "external_user_id"])
            .doUpdateSet({ visibility: "promoted", updated_at: new Date() }),
        )
        .execute();
      await this.notifications.publish({
        identity: { tenantId: chat.tenantId, externalUserId: approver },
        projectId: chat.projectId,
        sessionId: args.sessionId,
        kind: "approval_requested",
        title: `${args.agentLabel ?? "An agent"} needs your approval`,
        body: `${args.request.tool} on ${args.request.server}${
          chat.title ? ` in "${chat.title}"` : ""
        }`,
        route: `/?project=${encodeURIComponent(chat.projectId)}&session=${encodeURIComponent(args.sessionId)}`,
        collapseKey: `approval:${args.requestId}`,
      });
    }
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
    ...(payload.approvers ? { approvers: payload.approvers } : {}),
  };
}
