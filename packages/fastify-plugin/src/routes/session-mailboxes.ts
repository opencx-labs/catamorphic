import { SessionMailboxNotFoundError } from "@catamorphic/core";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { RouteContext } from "../app.js";
import { resolveIdentity } from "../http-identity.js";
import {
  AcknowledgeSessionMailboxSchema,
  ErrorSchema,
  OkSchema,
  ProjectIdParamsSchema,
  SessionMailboxIdParamsSchema,
  SessionMailboxListQuerySchema,
  SessionMailboxListSchema,
} from "../schemas.js";

export function registerSessionMailboxRoutes(
  app: FastifyInstance,
  ctx: RouteContext,
) {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.route({
    method: "GET",
    url: "/projects/:projectId/session-mailboxes",
    schema: {
      params: ProjectIdParamsSchema,
      querystring: SessionMailboxListQuerySchema,
      response: {
        200: SessionMailboxListSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      const mailboxes = ctx.core?.sessionMailboxes;
      if (!mailboxes) {
        return reply
          .status(503)
          .send({ error: "Agent sessions not configured" });
      }
      const items = await mailboxes.list(
        resolveIdentity(request),
        request.params.projectId,
        request.query,
      );
      return reply.send({ items });
    },
  });

  typed.route({
    method: "POST",
    url: "/projects/:projectId/session-mailboxes/:mailboxId/acknowledge",
    schema: {
      params: SessionMailboxIdParamsSchema,
      body: AcknowledgeSessionMailboxSchema,
      response: { 200: OkSchema, 404: ErrorSchema, 503: ErrorSchema },
    },
    handler: async (request, reply) => {
      const mailboxes = ctx.core?.sessionMailboxes;
      if (!mailboxes) {
        return reply
          .status(503)
          .send({ error: "Agent sessions not configured" });
      }
      try {
        await mailboxes.acknowledge(
          resolveIdentity(request),
          request.params.projectId,
          request.params.mailboxId,
          request.body,
        );
        return reply.send({ ok: true });
      } catch (error) {
        if (error instanceof SessionMailboxNotFoundError) {
          return reply.status(404).send({ error: error.message });
        }
        throw error;
      }
    },
  });
}
