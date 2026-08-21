import {
  AgentNotConfiguredError,
  AgentSessionClosedError,
  AgentSessionNotFoundError,
  AgentTurnInProgressError,
  ProjectNotFoundError,
  SessionMirrorDivergedError,
} from "@catamorphic/core";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { RouteContext } from "../app.js";
import { resolveIdentity } from "../http-identity.js";
import {
  AgentMessageSchema,
  AgentSessionDetailSchema,
  AgentSessionIdParamsSchema,
  AgentSessionSchema,
  CreateAgentSessionSchema,
  ErrorSchema,
  ForkAgentSessionSchema,
  ListSchema,
  MirrorAgentSessionSchema,
  MirrorConflictSchema,
  OkSchema,
  PaginationQuerySchema,
  PendingToolPermissionsSchema,
  ProjectAgentEntrySchema,
  ProjectIdParamsSchema,
  SendMessageSchema,
  SkillSchema,
  ToolPermissionDecisionSchema,
  ToolPermissionIdParamsSchema,
  UpdateAgentSessionSchema,
} from "../schemas.js";

export function registerAgentRoutes(app: FastifyInstance, ctx: RouteContext) {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.route({
    method: "POST",
    url: "/projects/:projectId/agent/sessions",
    schema: {
      params: ProjectIdParamsSchema,
      body: CreateAgentSessionSchema,
      response: {
        201: AgentSessionSchema,
        400: ErrorSchema,
        404: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      const agentSessions = ctx.core?.agentSessions;
      if (!agentSessions)
        return reply.status(503).send({ error: "Coding agent not configured" });
      const identity = resolveIdentity(request);
      try {
        const session = await agentSessions.create(
          identity,
          request.params.projectId,
          {
            systemPrompt: request.body.systemPrompt,
            agentId: request.body.agentId,
            effort: request.body.effort,
          },
        );
        return reply.status(201).send(session);
      } catch (err) {
        if (err instanceof ProjectNotFoundError) {
          return reply.status(404).send({ error: "Project not found" });
        }
        if (err instanceof AgentNotConfiguredError) {
          return reply.status(400).send({ error: err.message });
        }
        throw err;
      }
    },
  });

  // Session mirroring (ADR 0061): another backend (a linked desktop)
  // pushes a session's transcript here so members see it on this server
  // and can CONTINUE it here when the source dies. Idempotent per
  // message id; 409 with `diverged: true` once this server has messages
  // the source doesn't — the source must then stop pushing.
  typed.route({
    method: "PUT",
    url: "/projects/:projectId/agent/sessions/:sessionId/mirror",
    schema: {
      params: AgentSessionIdParamsSchema,
      body: MirrorAgentSessionSchema,
      response: {
        200: AgentSessionSchema,
        404: ErrorSchema,
        409: MirrorConflictSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      const agentSessions = ctx.core?.agentSessions;
      if (!agentSessions)
        return reply.status(503).send({ error: "Coding agent not configured" });
      const identity = resolveIdentity(request);
      try {
        const session = await agentSessions.mirror(
          identity,
          request.params.projectId,
          request.params.sessionId,
          {
            title: request.body.title ?? null,
            icon: request.body.icon ?? null,
            ...(request.body.provider
              ? { provider: request.body.provider }
              : {}),
            messages: request.body.messages.map((message) => ({
              ...message,
              metadata: message.metadata ?? null,
            })),
          },
        );
        return reply.send(session);
      } catch (err) {
        if (err instanceof ProjectNotFoundError) {
          return reply.status(404).send({ error: "Project not found" });
        }
        if (err instanceof SessionMirrorDivergedError) {
          return reply.status(409).send({ error: err.message, diverged: true });
        }
        if (err instanceof AgentTurnInProgressError) {
          return reply.status(409).send({
            error: "A turn is in progress here; try again when it settles",
            diverged: false,
          });
        }
        throw err;
      }
    },
  });

  typed.route({
    method: "PATCH",
    url: "/projects/:projectId/agent/sessions/:sessionId",
    schema: {
      params: AgentSessionIdParamsSchema,
      body: UpdateAgentSessionSchema,
      response: {
        200: AgentSessionSchema,
        400: ErrorSchema,
        404: ErrorSchema,
        409: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      const agentSessions = ctx.core?.agentSessions;
      if (!agentSessions)
        return reply.status(503).send({ error: "Coding agent not configured" });
      const identity = resolveIdentity(request);
      try {
        const session = await agentSessions.update(
          identity,
          request.params.projectId,
          request.params.sessionId,
          request.body,
        );
        return reply.send(session);
      } catch (err) {
        if (
          err instanceof ProjectNotFoundError ||
          err instanceof AgentSessionNotFoundError
        ) {
          return reply.status(404).send({ error: "Session not found" });
        }
        if (err instanceof AgentNotConfiguredError) {
          return reply.status(400).send({ error: err.message });
        }
        if (err instanceof AgentSessionClosedError) {
          return reply.status(409).send({ error: "Session is closed" });
        }
        if (err instanceof AgentTurnInProgressError) {
          return reply.status(409).send({
            error: "A turn is in progress; try again when it settles",
          });
        }
        throw err;
      }
    },
  });

  typed.route({
    method: "GET",
    url: "/projects/:projectId/agent/sessions",
    schema: {
      params: ProjectIdParamsSchema,
      querystring: PaginationQuerySchema,
      response: { 200: ListSchema(AgentSessionSchema), 404: ErrorSchema },
    },
    handler: async (request, reply) => {
      const agentSessions = ctx.core?.agentSessions;
      if (!agentSessions) return reply.send({ items: [], total: 0 });
      const identity = resolveIdentity(request);
      try {
        const result = await agentSessions.list(
          identity,
          request.params.projectId,
          request.query,
        );
        return reply.send(result);
      } catch (err) {
        if (err instanceof ProjectNotFoundError) {
          return reply.status(404).send({ error: "Project not found" });
        }
        throw err;
      }
    },
  });

  typed.route({
    method: "GET",
    url: "/projects/:projectId/agent/sessions/:sessionId",
    schema: {
      params: AgentSessionIdParamsSchema,
      response: {
        200: AgentSessionDetailSchema,
        404: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      const agentSessions = ctx.core?.agentSessions;
      if (!agentSessions)
        return reply.status(503).send({ error: "Coding agent not configured" });
      const identity = resolveIdentity(request);
      try {
        const detail = await agentSessions.get(
          identity,
          request.params.projectId,
          request.params.sessionId,
        );
        return reply.send(detail);
      } catch (err) {
        if (
          err instanceof ProjectNotFoundError ||
          err instanceof AgentSessionNotFoundError
        ) {
          return reply.status(404).send({ error: "Session not found" });
        }
        throw err;
      }
    },
  });

  typed.route({
    method: "POST",
    url: "/projects/:projectId/agent/sessions/:sessionId/messages",
    // Base64 media rides in the message body (~10MB per attachment, 4/3
    // inflated, up to 32); the rest of the API keeps Fastify's default cap.
    bodyLimit: 96 * 1024 * 1024,
    schema: {
      params: AgentSessionIdParamsSchema,
      body: SendMessageSchema,
      response: {
        201: AgentMessageSchema,
        404: ErrorSchema,
        409: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      const agentSessions = ctx.core?.agentSessions;
      if (!agentSessions)
        return reply.status(503).send({ error: "Coding agent not configured" });
      const identity = resolveIdentity(request);
      try {
        const message = await agentSessions.sendMessage(
          identity,
          request.params.projectId,
          request.params.sessionId,
          request.body.message,
          { attachments: request.body.attachments },
        );
        return reply.status(201).send(message);
      } catch (err) {
        if (
          err instanceof ProjectNotFoundError ||
          err instanceof AgentSessionNotFoundError
        ) {
          return reply.status(404).send({ error: "Session not found" });
        }
        if (err instanceof AgentSessionClosedError) {
          return reply.status(409).send({ error: "Session is closed" });
        }
        throw err;
      }
    },
  });

  // Tool permissions (ADR 0054), for hosts that answer "ask" over HTTP:
  // the pending asks of a session, and the answer. Only when the host
  // configured a broker (the desktop answers through its own bridge).
  typed.route({
    method: "GET",
    url: "/projects/:projectId/agent/sessions/:sessionId/permissions",
    schema: {
      params: AgentSessionIdParamsSchema,
      response: {
        200: PendingToolPermissionsSchema,
        404: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      const agentSessions = ctx.core?.agentSessions;
      const broker = ctx.core?.toolPermissions;
      if (!agentSessions || !broker) {
        return reply
          .status(503)
          .send({ error: "Tool permissions are not configured" });
      }
      try {
        await agentSessions.assertSession(
          resolveIdentity(request),
          request.params.projectId,
          request.params.sessionId,
        );
      } catch (err) {
        if (
          err instanceof ProjectNotFoundError ||
          err instanceof AgentSessionNotFoundError
        ) {
          return reply.status(404).send({ error: "Session not found" });
        }
        throw err;
      }
      return reply.send({
        permissions: broker.list(request.params.sessionId),
      });
    },
  });

  typed.route({
    method: "POST",
    url: "/projects/:projectId/agent/sessions/:sessionId/permissions/:permissionId",
    schema: {
      params: ToolPermissionIdParamsSchema,
      body: ToolPermissionDecisionSchema,
      response: { 200: OkSchema, 404: ErrorSchema, 503: ErrorSchema },
    },
    handler: async (request, reply) => {
      const agentSessions = ctx.core?.agentSessions;
      const broker = ctx.core?.toolPermissions;
      if (!agentSessions || !broker) {
        return reply
          .status(503)
          .send({ error: "Tool permissions are not configured" });
      }
      try {
        await agentSessions.assertSession(
          resolveIdentity(request),
          request.params.projectId,
          request.params.sessionId,
        );
      } catch (err) {
        if (
          err instanceof ProjectNotFoundError ||
          err instanceof AgentSessionNotFoundError
        ) {
          return reply.status(404).send({ error: "Session not found" });
        }
        throw err;
      }
      const pending = broker.get(request.params.permissionId);
      // An ask belongs to the session it was raised in — answering it from
      // another session's URL is a 404, not a hijack.
      if (!pending || pending.sessionId !== request.params.sessionId) {
        return reply.status(404).send({ error: "Permission not found" });
      }
      broker.answer(request.params.permissionId, request.body);
      return reply.send({ ok: true });
    },
  });

  // Re-run the last failed turn in place — no new user message; the failed
  // assistant row flips back to in-progress and settles with the retry.
  typed.route({
    method: "POST",
    url: "/projects/:projectId/agent/sessions/:sessionId/retry",
    schema: {
      params: AgentSessionIdParamsSchema,
      response: {
        201: AgentMessageSchema,
        404: ErrorSchema,
        409: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      const agentSessions = ctx.core?.agentSessions;
      if (!agentSessions)
        return reply.status(503).send({ error: "Coding agent not configured" });
      const identity = resolveIdentity(request);
      try {
        const message = await agentSessions.retry(
          identity,
          request.params.projectId,
          request.params.sessionId,
        );
        return reply.status(201).send(message);
      } catch (err) {
        if (
          err instanceof ProjectNotFoundError ||
          err instanceof AgentSessionNotFoundError
        ) {
          return reply.status(404).send({ error: "Session not found" });
        }
        if (
          err instanceof AgentSessionClosedError ||
          err instanceof AgentTurnInProgressError
        ) {
          return reply.status(409).send({ error: "Session is busy or closed" });
        }
        throw err;
      }
    },
  });

  // Fork the conversation: a new session on the same agent carrying the
  // transcript up to `messageId` (or all settled turns when omitted).
  typed.route({
    method: "POST",
    url: "/projects/:projectId/agent/sessions/:sessionId/fork",
    schema: {
      params: AgentSessionIdParamsSchema,
      body: ForkAgentSessionSchema,
      response: {
        201: AgentSessionSchema,
        404: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      const agentSessions = ctx.core?.agentSessions;
      if (!agentSessions)
        return reply.status(503).send({ error: "Coding agent not configured" });
      const identity = resolveIdentity(request);
      try {
        const session = await agentSessions.fork(
          identity,
          request.params.projectId,
          request.params.sessionId,
          { messageId: request.body?.messageId },
        );
        return reply.status(201).send(session);
      } catch (err) {
        if (
          err instanceof ProjectNotFoundError ||
          err instanceof AgentSessionNotFoundError
        ) {
          return reply.status(404).send({ error: "Session not found" });
        }
        throw err;
      }
    },
  });

  // Abort the in-flight turn (and cancel any scheduled auto-retry).
  typed.route({
    method: "POST",
    url: "/projects/:projectId/agent/sessions/:sessionId/interrupt",
    schema: {
      params: AgentSessionIdParamsSchema,
      response: {
        200: OkSchema,
        404: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      const agentSessions = ctx.core?.agentSessions;
      if (!agentSessions)
        return reply.status(503).send({ error: "Coding agent not configured" });
      const identity = resolveIdentity(request);
      try {
        await agentSessions.interrupt(
          identity,
          request.params.projectId,
          request.params.sessionId,
        );
        return reply.status(200).send({ ok: true });
      } catch (err) {
        if (
          err instanceof ProjectNotFoundError ||
          err instanceof AgentSessionNotFoundError
        ) {
          return reply.status(404).send({ error: "Session not found" });
        }
        throw err;
      }
    },
  });

  typed.route({
    method: "DELETE",
    url: "/projects/:projectId/agent/sessions/:sessionId",
    schema: {
      params: AgentSessionIdParamsSchema,
      response: { 200: AgentSessionSchema, 404: ErrorSchema, 503: ErrorSchema },
    },
    handler: async (request, reply) => {
      const agentSessions = ctx.core?.agentSessions;
      if (!agentSessions)
        return reply.status(503).send({ error: "Coding agent not configured" });
      const identity = resolveIdentity(request);
      try {
        const session = await agentSessions.close(
          identity,
          request.params.projectId,
          request.params.sessionId,
        );
        return reply.send(session);
      } catch (err) {
        if (
          err instanceof ProjectNotFoundError ||
          err instanceof AgentSessionNotFoundError
        ) {
          return reply.status(404).send({ error: "Session not found" });
        }
        throw err;
      }
    },
  });

  typed.route({
    method: "GET",
    url: "/projects/:projectId/skills",
    schema: {
      params: ProjectIdParamsSchema,
      response: {
        200: SkillSchema.array(),
        404: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!ctx.core)
        return reply.status(503).send({ error: "Service not configured" });
      const identity = resolveIdentity(request);
      try {
        const skills = await ctx.core.skills.list(
          identity,
          request.params.projectId,
        );
        return reply.send(skills);
      } catch (err) {
        if (err instanceof ProjectNotFoundError) {
          return reply.status(404).send({ error: "Project not found" });
        }
        throw err;
      }
    },
  });

  // Committed project agent definitions (`agents/*.json`, ADR 0050) —
  // parsed and validated; unusable files are reported per entry.
  typed.route({
    method: "GET",
    url: "/projects/:projectId/agents",
    schema: {
      params: ProjectIdParamsSchema,
      response: {
        200: ProjectAgentEntrySchema.array(),
        404: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!ctx.core)
        return reply.status(503).send({ error: "Service not configured" });
      const identity = resolveIdentity(request);
      try {
        const agents = await ctx.core.agentDefinitions.list(
          identity,
          request.params.projectId,
        );
        return reply.send(agents);
      } catch (err) {
        if (err instanceof ProjectNotFoundError) {
          return reply.status(404).send({ error: "Project not found" });
        }
        throw err;
      }
    },
  });
}
