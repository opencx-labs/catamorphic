import type { JsonObject, JsonValue } from "@catamorphic/agent-protocol";
import {
  AccessDeniedError,
  AgentDelegationDeniedError,
  AgentNotConfiguredError,
  AgentSessionArchiveConfirmationRequiredError,
  AgentSessionAuthorityRequiredError,
  AgentSessionClosedError,
  AgentSessionHandoffPendingError,
  AgentSessionNotFoundError,
  AgentTurnInProgressError,
  AuthenticationRequiredError,
  EnvironmentAccessDeniedError,
  EnvironmentBindingUnavailableError,
  EnvironmentCapacityError,
  EnvironmentIncompatibleError,
  EnvironmentNotFoundError,
  ForeignSessionEventError,
  keyedChatOwnerId,
  NoCompatibleEnvironmentError,
  ProjectNotFoundError,
  parseChatKey,
  SessionMirrorBehindError,
  SessionMirrorDivergedError,
  UnsupportedAgentTopologyError,
} from "@catamorphic/core";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { RouteContext } from "../app.js";
import { resolveIdentity } from "../http-identity.js";
import {
  AgentCatalogSchema,
  AgentSessionArchiveConfirmationSchema,
  AgentSessionArchiveImpactSchema,
  AgentSessionArchiveResultSchema,
  AgentSessionDetailSchema,
  AgentSessionIdParamsSchema,
  AgentSessionPeerSchema,
  AgentSessionSchema,
  AgentSessionsQuerySchema,
  AgentSubsessionIdParamsSchema,
  AgentSubsessionSchema,
  ArchiveAgentSessionSchema,
  AuthenticationRequiredSchema,
  ClosedKeyedChatSchema,
  CommandReceiptSchema,
  CreateAgentSessionSchema,
  CreateAgentSubsessionSchema,
  EnvironmentAccessErrorSchema,
  EnvironmentErrorSchema,
  ErrorSchema,
  ForkAgentSessionSchema,
  KeyedChatParamsSchema,
  KeyedChatQuerySchema,
  ListSchema,
  MirrorAgentSessionResultSchema,
  MirrorAgentSessionSchema,
  MirrorConflictSchema,
  MirrorExportSchema,
  OkSchema,
  ProjectAgentEntrySchema,
  ProjectIdParamsSchema,
  ResumeAgentSessionSchema,
  SessionCommandSchema,
  SessionConflictSchema,
  SessionEventsQuerySchema,
  SessionItemsPageSchema,
  SessionItemsQuerySchema,
  SessionMirrorQuerySchema,
  SessionStreamMessageSchema,
  SkillSchema,
  UpdateAgentSessionActivitySchema,
  UpdateAgentSessionSchema,
  WaitForAgentSubsessionsSchema,
} from "../schemas.js";
import { SessionEventStream } from "../session-event-stream.js";

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
        403: EnvironmentAccessErrorSchema,
        409: EnvironmentErrorSchema,
        422: EnvironmentErrorSchema,
        428: AuthenticationRequiredSchema,
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
            model: request.body.model,
            effort: request.body.effort,
            environment: request.body.environment,
            source: request.body.source,
            parentSessionId: request.body.parentSessionId,
            title: request.body.title,
            ...(request.body.workspace
              ? { workspace: request.body.workspace }
              : {}),
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
        if (err instanceof AgentSessionClosedError) {
          return reply
            .status(409)
            .send({ error: err.message, code: "parent_session_closed" });
        }
        if (err instanceof AuthenticationRequiredError) {
          return reply.status(428).send({
            error: err.message,
            code: "authentication_required",
            environment: err.environment,
            requirements: [...err.requirements],
          });
        }
        if (err instanceof EnvironmentAccessDeniedError) {
          return reply.status(403).send({
            error: err.message,
            code: "environment_access_denied",
          });
        }
        if (
          err instanceof EnvironmentCapacityError ||
          err instanceof EnvironmentBindingUnavailableError ||
          err instanceof EnvironmentNotFoundError
        ) {
          return reply.status(409).send({
            error: err.message,
            code:
              err instanceof EnvironmentCapacityError
                ? "environment_full"
                : "environment_unavailable",
          });
        }
        if (err instanceof NoCompatibleEnvironmentError)
          return reply.status(422).send({
            error: err.message,
            code: "environment_unavailable",
            reasons: Object.values(err.reasons).flatMap((items) => [...items]),
          });
        if (err instanceof EnvironmentIncompatibleError) {
          return reply.status(422).send({
            error: err.message,
            code: "environment_incompatible",
            reasons: [...err.reasons],
          });
        }
        if (err instanceof UnsupportedAgentTopologyError) {
          return reply.status(422).send({
            error: err.message,
            code: "agent_topology_unsupported",
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
        403: EnvironmentAccessErrorSchema,
        404: ErrorSchema,
        409: z.union([SessionConflictSchema, ErrorSchema]),
        422: EnvironmentErrorSchema,
        428: AuthenticationRequiredSchema,
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
        if (err instanceof AuthenticationRequiredError) {
          return reply.status(428).send({
            error: err.message,
            code: "authentication_required",
            environment: err.environment,
            requirements: [...err.requirements],
          });
        }
        const conflict = sessionConflict(err);
        if (conflict) return reply.status(409).send(conflict);
        if (err instanceof AgentTurnInProgressError) {
          return reply.status(409).send({
            error: "A turn is in progress; try again when it settles",
          });
        }
        if (err instanceof EnvironmentAccessDeniedError) {
          return reply.status(403).send({
            error: err.message,
            code: "environment_access_denied",
          });
        }
        if (
          err instanceof EnvironmentCapacityError ||
          err instanceof EnvironmentBindingUnavailableError ||
          err instanceof EnvironmentNotFoundError
        ) {
          return reply.status(409).send({
            error: err.message,
          });
        }
        if (err instanceof NoCompatibleEnvironmentError)
          return reply.status(422).send({
            error: err.message,
            code: "environment_unavailable",
            reasons: Object.values(err.reasons).flatMap((items) => [...items]),
          });
        if (err instanceof EnvironmentIncompatibleError) {
          return reply.status(422).send({
            error: err.message,
            code: "environment_incompatible",
            reasons: [...err.reasons],
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
      querystring: AgentSessionsQuerySchema,
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

  // Older items of a session, paging back from a snapshot's `olderBefore`.
  typed.route({
    method: "GET",
    url: "/projects/:projectId/agent/sessions/:sessionId/items",
    schema: {
      params: AgentSessionIdParamsSchema,
      querystring: SessionItemsQuerySchema,
      response: {
        200: SessionItemsPageSchema,
        404: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      const agentSessions = ctx.core?.agentSessions;
      if (!agentSessions)
        return reply.status(503).send({ error: "Coding agent not configured" });
      try {
        return reply.send(
          await agentSessions.items(
            resolveIdentity(request),
            request.params.projectId,
            request.params.sessionId,
            {
              before: request.query.before,
              ...(request.query.limit ? { limit: request.query.limit } : {}),
            },
          ),
        );
      } catch (error) {
        if (
          error instanceof ProjectNotFoundError ||
          error instanceof AgentSessionNotFoundError
        )
          return reply.status(404).send({ error: "Session not found" });
        throw error;
      }
    },
  });

  // The session's events after a cursor, as server-sent events (ADR 0196):
  // the gap (or `reset` with a fresh snapshot when it is too large), then
  // live events, with a heartbeat every 15 seconds. A reader that falls too
  // far behind is closed and resumes from its cursor, which each event's
  // `id:` carries, so a browser EventSource resumes by itself.
  typed.route({
    method: "GET",
    url: "/projects/:projectId/agent/sessions/:sessionId/events",
    schema: {
      params: AgentSessionIdParamsSchema,
      querystring: SessionEventsQuerySchema,
      headers: z.looseObject({
        "last-event-id": z
          .string()
          .regex(/^\d+$/)
          .optional()
          .describe(
            "The last sequence the client applied; a reconnecting EventSource sends it, and it wins over `after`",
          ),
      }),
      response: {
        200: {
          description:
            "A stream of `data: <SessionStreamMessage JSON>` events; each `id:` is the stream's sequence",
          content: {
            "text/event-stream": { schema: SessionStreamMessageSchema },
          },
        },
        404: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      const agentSessions = ctx.core?.agentSessions;
      if (!agentSessions)
        return reply.status(503).send({ error: "Coding agent not configured" });
      const lastEventId = request.headers["last-event-id"];
      const after =
        lastEventId !== undefined
          ? Number(lastEventId)
          : (request.query.after ?? 0);
      const stream = new SessionEventStream({
        raw: reply.raw,
        sequence: after,
      });
      try {
        stream.attach(
          await agentSessions.subscribe(
            resolveIdentity(request),
            request.params.projectId,
            request.params.sessionId,
            {
              after,
              send: (message) => stream.send(message),
              onClose: () => stream.end(),
            },
          ),
        );
      } catch (error) {
        stream.end();
        if (
          error instanceof ProjectNotFoundError ||
          error instanceof AgentSessionNotFoundError
        )
          return reply.status(404).send({ error: "Session not found" });
        throw error;
      }
      reply.hijack();
      stream.open(reply.getHeaders());
      return reply;
    },
  });

  // A person's command to a session (ADR 0196): send, interrupt, retry,
  // queue edits, send now, answer a request, roll back. Each carries a
  // client `commandId`; sending it again returns the first receipt. A
  // refusal is a durable answer too, so both receipts are 200.
  typed.route({
    method: "POST",
    url: "/projects/:projectId/agent/sessions/:sessionId/commands",
    // Base64 media rides in a send's attachments; the rest of the API keeps
    // Fastify's default cap.
    bodyLimit: 96 * 1024 * 1024,
    schema: {
      params: AgentSessionIdParamsSchema,
      body: SessionCommandSchema,
      response: {
        200: CommandReceiptSchema,
        404: ErrorSchema,
        409: SessionConflictSchema,
        422: EnvironmentErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      const agentSessions = ctx.core?.agentSessions;
      if (!agentSessions)
        return reply.status(503).send({ error: "Coding agent not configured" });
      try {
        return reply.send(
          await agentSessions.command(
            resolveIdentity(request),
            request.params.projectId,
            request.params.sessionId,
            request.body,
          ),
        );
      } catch (err) {
        if (
          err instanceof ProjectNotFoundError ||
          err instanceof AgentSessionNotFoundError
        )
          return reply.status(404).send({ error: "Session not found" });
        const conflict = sessionConflict(err);
        if (conflict) return reply.status(409).send(conflict);
        if (err instanceof UnsupportedAgentTopologyError)
          return reply.status(422).send({
            error: err.message,
            code: "agent_topology_unsupported",
          });
        throw err;
      }
    },
  });

  // Session mirroring (ADR 0196): another backend (a linked desktop)
  // pushes the session's log after this copy's sequence, so members see it
  // here and can continue it when the source is gone. A copy that does not
  // exist yet starts from the push's `base` snapshot.
  // A mirrored chat is continued here: this host takes its authority, if
  // the source still holds the revision the caller saw (ADR 0077).
  typed.route({
    method: "POST",
    url: "/projects/:projectId/agent/sessions/:sessionId/resume",
    schema: {
      params: AgentSessionIdParamsSchema,
      body: ResumeAgentSessionSchema,
      response: {
        200: AgentSessionSchema,
        404: ErrorSchema,
        409: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      const agentSessions = ctx.core?.agentSessions;
      if (!agentSessions) {
        return reply.status(503).send({ error: "Coding agent not configured" });
      }
      try {
        return reply.send(
          await agentSessions.resume(
            resolveIdentity(request),
            request.params.projectId,
            request.params.sessionId,
            request.body,
          ),
        );
      } catch (error) {
        if (
          error instanceof ProjectNotFoundError ||
          error instanceof AgentSessionNotFoundError
        ) {
          return reply.status(404).send({ error: "Session not found" });
        }
        if (
          error instanceof AgentSessionClosedError ||
          error instanceof SessionMirrorDivergedError
        ) {
          return reply.status(409).send({ error: error.message });
        }
        throw error;
      }
    },
  });

  typed.route({
    method: "PUT",
    url: "/projects/:projectId/agent/sessions/:sessionId/mirror",
    // A new copy carries a whole session (tool inputs and results
    // included): the order of the media one message may carry.
    bodyLimit: 96 * 1024 * 1024,
    schema: {
      params: AgentSessionIdParamsSchema,
      body: MirrorAgentSessionSchema,
      response: {
        200: MirrorAgentSessionResultSchema,
        400: ErrorSchema,
        403: EnvironmentAccessErrorSchema,
        404: ErrorSchema,
        409: z.union([MirrorConflictSchema, EnvironmentErrorSchema]),
        422: EnvironmentErrorSchema,
        428: AuthenticationRequiredSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      const agentSessions = ctx.core?.agentSessions;
      if (!agentSessions)
        return reply.status(503).send({ error: "Coding agent not configured" });
      try {
        const { sequence, agentNotice, ...session } =
          await agentSessions.mirror(
            resolveIdentity(request),
            request.params.projectId,
            request.params.sessionId,
            request.body,
          );
        return reply.send({
          session,
          sequence,
          ...(agentNotice ? { agentNotice } : {}),
        });
      } catch (err) {
        if (err instanceof ProjectNotFoundError)
          return reply.status(404).send({ error: "Project not found" });
        if (err instanceof ForeignSessionEventError)
          return reply.status(400).send({ error: err.message });
        if (err instanceof SessionMirrorDivergedError)
          return reply
            .status(409)
            .send({ error: err.message, code: "diverged" as const });
        if (err instanceof SessionMirrorBehindError)
          return reply.status(409).send({
            error: err.message,
            code: "behind" as const,
            sequence: err.sequence,
          });
        if (err instanceof AgentTurnInProgressError)
          return reply.status(409).send({
            error: "A turn is in progress here; push again when it settles",
            code: "turn_in_progress" as const,
          });
        if (err instanceof AuthenticationRequiredError)
          return reply.status(428).send({
            error: err.message,
            code: "authentication_required",
            environment: err.environment,
            requirements: [...err.requirements],
          });
        if (err instanceof EnvironmentAccessDeniedError)
          return reply.status(403).send({
            error: err.message,
            code: "environment_access_denied",
          });
        if (
          err instanceof EnvironmentCapacityError ||
          err instanceof EnvironmentBindingUnavailableError ||
          err instanceof EnvironmentNotFoundError
        )
          return reply.status(409).send({
            error: err.message,
            code:
              err instanceof EnvironmentCapacityError
                ? "environment_full"
                : "environment_unavailable",
          });
        if (err instanceof NoCompatibleEnvironmentError)
          return reply.status(422).send({
            error: err.message,
            code: "environment_unavailable",
            reasons: Object.values(err.reasons).flatMap((items) => [...items]),
          });
        if (err instanceof EnvironmentIncompatibleError)
          return reply.status(422).send({
            error: err.message,
            code: "environment_incompatible",
            reasons: [...err.reasons],
          });
        throw err;
      }
    },
  });

  // What a mirror of this session pushes (ADR 0196): its log after the
  // copy's sequence, or the whole session (`base`) for a copy that does not
  // exist yet or fell too far behind.
  typed.route({
    method: "GET",
    url: "/projects/:projectId/agent/sessions/:sessionId/mirror",
    schema: {
      params: AgentSessionIdParamsSchema,
      querystring: SessionMirrorQuerySchema,
      response: {
        200: MirrorExportSchema,
        404: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      const agentSessions = ctx.core?.agentSessions;
      if (!agentSessions)
        return reply.status(503).send({ error: "Coding agent not configured" });
      try {
        const { projectEvents, ...exported } = await agentSessions.mirrorExport(
          {
            identity: resolveIdentity(request),
            projectId: request.params.projectId,
            sessionId: request.params.sessionId,
            after: request.query.after ?? null,
          },
        );
        return reply.send({
          ...exported,
          ...(projectEvents
            ? {
                projectEvents: projectEvents.map((event) => ({
                  ...event,
                  payload: wireObject(event.payload),
                })),
              }
            : {}),
        });
      } catch (error) {
        if (
          error instanceof ProjectNotFoundError ||
          error instanceof AgentSessionNotFoundError
        )
          return reply.status(404).send({ error: "Session not found" });
        throw error;
      }
    },
  });

  typed.route({
    method: "POST",
    url: "/projects/:projectId/agent/sessions/:sessionId/attention/acknowledge",
    schema: {
      params: AgentSessionIdParamsSchema,
      body: z
        .object({ observedRevision: z.number().int().nonnegative().optional() })
        .nullish(),
      response: {
        200: AgentSessionSchema,
        404: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      const agentSessions = ctx.core?.agentSessions;
      if (!agentSessions) {
        return reply.status(503).send({ error: "Coding agent not configured" });
      }
      const identity = resolveIdentity(request);
      try {
        return reply.send(
          await agentSessions.acknowledgeAttention(
            identity,
            request.params.projectId,
            request.params.sessionId,
            request.body ?? {},
          ),
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
    },
  });

  typed.route({
    method: "GET",
    url: "/projects/:projectId/agent/sessions/:sessionId/peers",
    schema: {
      params: AgentSessionIdParamsSchema,
      response: {
        200: AgentSessionPeerSchema.array(),
        404: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      const agentSessions = ctx.core?.agentSessions;
      if (!agentSessions) {
        return reply.status(503).send({ error: "Coding agent not configured" });
      }
      try {
        return reply.send(
          await agentSessions.listPeers(
            resolveIdentity(request),
            request.params.projectId,
            request.params.sessionId,
          ),
        );
      } catch (error) {
        if (
          error instanceof ProjectNotFoundError ||
          error instanceof AgentSessionNotFoundError
        ) {
          return reply.status(404).send({ error: "Session not found" });
        }
        throw error;
      }
    },
  });

  typed.route({
    method: "POST",
    url: "/projects/:projectId/agent/sessions/:sessionId/subsessions",
    schema: {
      params: AgentSessionIdParamsSchema,
      body: CreateAgentSubsessionSchema,
      response: {
        201: AgentSubsessionSchema,
        400: ErrorSchema,
        403: ErrorSchema,
        404: ErrorSchema,
        409: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      const agentSessions = ctx.core?.agentSessions;
      if (!agentSessions) {
        return reply.status(503).send({ error: "Coding agent not configured" });
      }
      try {
        const child = await agentSessions.createSubsession(
          resolveIdentity(request),
          request.params.projectId,
          request.params.sessionId,
          request.body,
        );
        return reply.status(201).send(child);
      } catch (error) {
        if (
          error instanceof ProjectNotFoundError ||
          error instanceof AgentSessionNotFoundError
        ) {
          return reply.status(404).send({ error: "Session not found" });
        }
        if (error instanceof AgentDelegationDeniedError) {
          return reply.status(403).send({ error: error.message });
        }
        if (error instanceof AgentNotConfiguredError) {
          return reply.status(400).send({ error: error.message });
        }
        if (error instanceof AgentSessionClosedError) {
          return reply.status(409).send({ error: error.message });
        }
        throw error;
      }
    },
  });

  typed.route({
    method: "GET",
    url: "/projects/:projectId/agent/sessions/:sessionId/subsessions",
    schema: {
      params: AgentSessionIdParamsSchema,
      response: {
        200: AgentSubsessionSchema.array(),
        404: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      const agentSessions = ctx.core?.agentSessions;
      if (!agentSessions) {
        return reply.status(503).send({ error: "Coding agent not configured" });
      }
      try {
        return reply.send(
          await agentSessions.listSubsessions(
            resolveIdentity(request),
            request.params.projectId,
            request.params.sessionId,
          ),
        );
      } catch (error) {
        if (
          error instanceof ProjectNotFoundError ||
          error instanceof AgentSessionNotFoundError
        ) {
          return reply.status(404).send({ error: "Session not found" });
        }
        throw error;
      }
    },
  });

  typed.route({
    method: "POST",
    url: "/projects/:projectId/agent/sessions/:sessionId/subsessions/wait",
    schema: {
      params: AgentSessionIdParamsSchema,
      body: WaitForAgentSubsessionsSchema,
      response: {
        200: AgentSubsessionSchema.array(),
        404: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      const agentSessions = ctx.core?.agentSessions;
      if (!agentSessions) {
        return reply.status(503).send({ error: "Coding agent not configured" });
      }
      try {
        return reply.send(
          await agentSessions.waitForSubsessions(
            resolveIdentity(request),
            request.params.projectId,
            request.params.sessionId,
            request.body,
          ),
        );
      } catch (error) {
        if (
          error instanceof ProjectNotFoundError ||
          error instanceof AgentSessionNotFoundError
        ) {
          return reply.status(404).send({ error: "Session not found" });
        }
        throw error;
      }
    },
  });

  typed.route({
    method: "POST",
    url: "/projects/:projectId/agent/sessions/:sessionId/subsessions/:childSessionId/interrupt",
    schema: {
      params: AgentSubsessionIdParamsSchema,
      response: {
        200: OkSchema,
        403: ErrorSchema,
        404: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      const agentSessions = ctx.core?.agentSessions;
      if (!agentSessions) {
        return reply.status(503).send({ error: "Coding agent not configured" });
      }
      try {
        await agentSessions.interruptSubsession(
          resolveIdentity(request),
          request.params.projectId,
          request.params.sessionId,
          request.params.childSessionId,
        );
        return reply.send({ ok: true });
      } catch (error) {
        if (
          error instanceof ProjectNotFoundError ||
          error instanceof AgentSessionNotFoundError
        ) {
          return reply.status(404).send({ error: "Session not found" });
        }
        if (error instanceof AgentDelegationDeniedError) {
          return reply.status(403).send({ error: error.message });
        }
        throw error;
      }
    },
  });

  typed.route({
    method: "POST",
    url: "/projects/:projectId/agent/sessions/:sessionId/attention",
    schema: {
      params: AgentSessionIdParamsSchema,
      response: {
        200: AgentSessionSchema,
        404: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      const agentSessions = ctx.core?.agentSessions;
      if (!agentSessions) {
        return reply.status(503).send({ error: "Coding agent not configured" });
      }
      try {
        return reply.send(
          await agentSessions.requestAttention(
            resolveIdentity(request),
            request.params.projectId,
            request.params.sessionId,
          ),
        );
      } catch (error) {
        if (
          error instanceof ProjectNotFoundError ||
          error instanceof AgentSessionNotFoundError
        ) {
          return reply.status(404).send({ error: "Session not found" });
        }
        throw error;
      }
    },
  });

  typed.route({
    method: "PATCH",
    url: "/projects/:projectId/agent/sessions/:sessionId/activity",
    schema: {
      params: AgentSessionIdParamsSchema,
      body: UpdateAgentSessionActivitySchema,
      response: { 200: OkSchema, 404: ErrorSchema, 503: ErrorSchema },
    },
    handler: async (request, reply) => {
      const agentSessions = ctx.core?.agentSessions;
      if (!agentSessions) {
        return reply.status(503).send({ error: "Coding agent not configured" });
      }
      try {
        await agentSessions.setActivity(
          resolveIdentity(request),
          request.params.projectId,
          request.params.sessionId,
          request.body.activity,
        );
        return reply.send({ ok: true });
      } catch (error) {
        if (
          error instanceof ProjectNotFoundError ||
          error instanceof AgentSessionNotFoundError
        ) {
          return reply.status(404).send({ error: "Session not found" });
        }
        throw error;
      }
    },
  });

  // Fork the conversation: a new session on the same agent carrying the
  // transcript through the item `messageId` names (or every settled turn).
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

  // A chat by the project's key (ADR 0173). Finding never starts a chat.
  typed.get(
    "/projects/:projectId/agent/chats/:key",
    {
      schema: {
        params: KeyedChatParamsSchema,
        querystring: KeyedChatQuerySchema,
        response: {
          200: AgentSessionSchema,
          404: ErrorSchema,
          503: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const agentSessions = ctx.core?.agentSessions;
      if (!agentSessions)
        return reply.status(503).send({ error: "Coding agent not configured" });
      const identity = resolveIdentity(request);
      const { projectId } = request.params;
      const sessionId = await agentSessions.keyedChatId({
        projectId,
        key: parseChatKey(request.params.key),
        ownerId: keyedChatOwnerId({
          caller: identity,
          audience: keyedAudience(request.query),
        }),
      });
      if (!sessionId) return reply.status(404).send({ error: "No open chat" });
      try {
        return reply.send(
          await agentSessions.get(identity, projectId, sessionId),
        );
      } catch (err) {
        // A chat the caller may not see answers like no chat at all.
        if (
          err instanceof ProjectNotFoundError ||
          err instanceof AgentSessionNotFoundError ||
          err instanceof AccessDeniedError
        )
          return reply.status(404).send({ error: "No open chat" });
        throw err;
      }
    },
  );

  // Close a keyed chat: its work, workspace and key are released; the
  // transcript stays readable. Closing a key with no open chat is a no-op.
  typed.route({
    method: "DELETE",
    url: "/projects/:projectId/agent/chats/:key",
    schema: {
      params: KeyedChatParamsSchema,
      querystring: KeyedChatQuerySchema,
      response: {
        200: ClosedKeyedChatSchema,
        404: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      const agentSessions = ctx.core?.agentSessions;
      if (!agentSessions)
        return reply.status(503).send({ error: "Coding agent not configured" });
      const identity = resolveIdentity(request);
      const { projectId } = request.params;
      const sessionId = await agentSessions.keyedChatId({
        projectId,
        key: parseChatKey(request.params.key),
        ownerId: keyedChatOwnerId({
          caller: identity,
          audience: keyedAudience(request.query),
        }),
      });
      if (!sessionId) return reply.send({ sessionId: null, closed: false });
      try {
        await agentSessions.close(identity, projectId, sessionId);
        return reply.send({ sessionId, closed: true });
      } catch (err) {
        if (err instanceof ProjectNotFoundError)
          return reply.status(404).send({ error: "No open chat" });
        // A chat the caller may not reach answers like no open chat.
        if (
          err instanceof AgentSessionNotFoundError ||
          err instanceof AccessDeniedError
        )
          return reply.send({ sessionId: null, closed: false });
        throw err;
      }
    },
  });

  typed.get(
    "/projects/:projectId/agent/sessions/:sessionId/archive-impact",
    {
      schema: {
        params: AgentSessionIdParamsSchema,
        response: {
          200: AgentSessionArchiveImpactSchema,
          404: ErrorSchema,
          503: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const sessions = ctx.core?.agentSessions;
      if (!sessions)
        return reply.status(503).send({ error: "Coding agent not configured" });
      try {
        return reply.send(
          await sessions.archiveImpact(
            resolveIdentity(request),
            request.params.projectId,
            request.params.sessionId,
          ),
        );
      } catch (error) {
        if (
          error instanceof ProjectNotFoundError ||
          error instanceof AgentSessionNotFoundError
        )
          return reply.status(404).send({ error: "Session not found" });
        throw error;
      }
    },
  );

  typed.route({
    method: "POST",
    url: "/projects/:projectId/agent/sessions/:sessionId/archive",
    schema: {
      params: AgentSessionIdParamsSchema,
      body: ArchiveAgentSessionSchema,
      response: {
        200: AgentSessionArchiveResultSchema,
        404: ErrorSchema,
        409: AgentSessionArchiveConfirmationSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      const agentSessions = ctx.core?.agentSessions;
      if (!agentSessions) {
        return reply.status(503).send({ error: "Coding agent not configured" });
      }
      try {
        return reply.send(
          await agentSessions.archive(
            resolveIdentity(request),
            request.params.projectId,
            request.params.sessionId,
            request.body,
          ),
        );
      } catch (error) {
        if (
          error instanceof ProjectNotFoundError ||
          error instanceof AgentSessionNotFoundError
        ) {
          return reply.status(404).send({ error: "Session not found" });
        }
        if (error instanceof AgentSessionArchiveConfirmationRequiredError) {
          return reply.status(409).send({
            error: error.message,
            code: "archive_confirmation_required",
            impact: error.impact,
          });
        }
        throw error;
      }
    },
  });

  typed.route({
    method: "POST",
    url: "/projects/:projectId/agent/sessions/:sessionId/unarchive",
    schema: {
      params: AgentSessionIdParamsSchema,
      response: {
        200: AgentSessionSchema.array(),
        404: ErrorSchema,
        403: ErrorSchema,
        409: ErrorSchema,
        422: ErrorSchema,
        428: AuthenticationRequiredSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      const agentSessions = ctx.core?.agentSessions;
      if (!agentSessions) {
        return reply.status(503).send({ error: "Coding agent not configured" });
      }
      try {
        return reply.send(
          await agentSessions.unarchive(
            resolveIdentity(request),
            request.params.projectId,
            request.params.sessionId,
          ),
        );
      } catch (error) {
        if (
          error instanceof EnvironmentCapacityError ||
          error instanceof EnvironmentBindingUnavailableError
        )
          return reply.status(409).send({ error: error.message });
        if (error instanceof EnvironmentAccessDeniedError)
          return reply.status(403).send({ error: error.message });
        if (
          error instanceof EnvironmentIncompatibleError ||
          error instanceof NoCompatibleEnvironmentError
        )
          return reply.status(422).send({ error: error.message });
        if (error instanceof AuthenticationRequiredError)
          return reply.status(428).send({
            error: error.message,
            code: "authentication_required",
            environment: error.environment,
            requirements: [...error.requirements],
          });
        if (
          error instanceof ProjectNotFoundError ||
          error instanceof AgentSessionNotFoundError
        ) {
          return reply.status(404).send({ error: "Session not found" });
        }
        throw error;
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

  typed.route({
    method: "GET",
    url: "/projects/:projectId/agent-catalog",
    schema: {
      params: ProjectIdParamsSchema,
      response: { 200: AgentCatalogSchema, 404: ErrorSchema, 503: ErrorSchema },
    },
    handler: async (request, reply) => {
      if (!ctx.core?.agentSessions)
        return reply.status(503).send({ error: "Agents are not configured" });
      return reply.send(
        AgentCatalogSchema.parse(
          await ctx.core.agentSessions.catalog({
            identity: resolveIdentity(request),
            projectId: request.params.projectId,
          }),
        ),
      );
    },
  });

  // Committed project agent definitions (`.work/agents/*.json`, ADR 0050) —
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

/**
 * A stored JSON object as wire JSON: members holding `undefined` are
 * dropped, as serializing would drop them.
 */
/** A session's refusal of a change, as a 409 body; null when it is not one. */
function sessionConflict(
  err: unknown,
): z.infer<typeof SessionConflictSchema> | null {
  if (err instanceof AgentSessionClosedError)
    return { error: "Session is closed", code: "session_closed" };
  if (err instanceof AgentSessionAuthorityRequiredError)
    return {
      error: err.message,
      code: "authority_required",
      authorityRevision: err.authorityRevision,
    };
  if (err instanceof AgentSessionHandoffPendingError)
    return { error: err.message, code: "handoff_pending" };
  return null;
}

function wireObject(value: object): JsonObject {
  return Object.fromEntries(
    Object.entries(value)
      .filter((entry) => entry[1] !== undefined)
      .map(([key, member]) => [key, wireJson(member)]),
  );
}

function wireJson(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return value;
  if (Array.isArray(value))
    return value.map((member) =>
      member === undefined ? null : wireJson(member),
    );
  return typeof value === "object" ? wireObject(value) : null;
}

function keyedAudience(query: {
  audience?: "project";
  member?: string;
}): "project" | { member: string } | undefined {
  if (query.audience) return query.audience;
  return query.member ? { member: query.member } : undefined;
}
