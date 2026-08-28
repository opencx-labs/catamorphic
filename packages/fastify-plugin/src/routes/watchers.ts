import {
  AgentSessionNotFoundError,
  ProjectNotFoundError,
} from "@catamorphic/core";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { RouteContext } from "../app.js";
import { resolveIdentity } from "../http-identity.js";
import {
  AgentSessionIdParamsSchema,
  ErrorSchema,
  ListSchema,
  OkSchema,
  WatcherIdParamsSchema,
  WatcherSchema,
} from "../schemas.js";

export function registerWatcherRoutes(app: FastifyInstance, ctx: RouteContext) {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.route({
    method: "GET",
    url: "/projects/:projectId/agent/sessions/:sessionId/watchers",
    schema: {
      params: AgentSessionIdParamsSchema,
      response: {
        200: ListSchema(WatcherSchema),
        404: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      const watchers = ctx.core?.watchers;
      if (!watchers) {
        return reply.status(503).send({ error: "Watchers are not configured" });
      }
      try {
        const items = await watchers.list({
          identity: resolveIdentity(request),
          projectId: request.params.projectId,
          sessionId: request.params.sessionId,
        });
        return reply.send({ items, total: items.length });
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
    method: "DELETE",
    url: "/projects/:projectId/agent/sessions/:sessionId/watchers/:watcherId",
    schema: {
      params: WatcherIdParamsSchema,
      response: {
        200: OkSchema,
        404: ErrorSchema,
        409: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      const watchers = ctx.core?.watchers;
      if (!watchers) {
        return reply.status(503).send({ error: "Watchers are not configured" });
      }
      try {
        const stopped = await watchers.stop({
          identity: resolveIdentity(request),
          projectId: request.params.projectId,
          sessionId: request.params.sessionId,
          watcherId: request.params.watcherId,
        });
        return stopped
          ? reply.send({ ok: true })
          : reply.status(409).send({ error: "Watcher is already terminal" });
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
}
