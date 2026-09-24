import {
  WEBHOOK_MAX_BYTES,
  WebhookNotFoundError,
  WebhookRejectedError,
} from "@catamorphic/core";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { RouteContext } from "../app.js";
import { resolveIdentity } from "../http-identity.js";
import { ErrorSchema, ProjectIdParamsSchema } from "../schemas.js";

const WebhookSchema = z.object({
  name: z.string(),
  url: z.string(),
  workflows: z.array(z.string()),
  listening: z.boolean(),
  verified: z.boolean(),
});

/**
 * Project webhooks (ADR 0156). The intake is public: the token in its path
 * is the sender's credential, checked with the declared signature before
 * anything is stored. `webhooks:read` lists the URLs; `webhooks:write`
 * rotates their tokens.
 */
export function registerWebhookRoutes(
  app: FastifyInstance,
  ctx: RouteContext,
): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const apiBase = (request: FastifyRequest) =>
    ctx.publicApiBase ??
    `${request.protocol}://${request.host}${app.prefix}`.replace(/\/$/, "");

  // Senders sign the exact bytes: keep every body raw on this route only.
  app.register(async (intake) => {
    intake.removeAllContentTypeParsers();
    intake.addContentTypeParser(
      "*",
      { parseAs: "buffer", bodyLimit: WEBHOOK_MAX_BYTES },
      (_request, body, done) => done(null, body),
    );
    intake.withTypeProvider<ZodTypeProvider>().route({
      method: "POST",
      url: "/hooks/:projectId/:name/:token",
      config: { public: true },
      bodyLimit: WEBHOOK_MAX_BYTES,
      schema: {
        params: z.object({
          projectId: z.string().uuid(),
          name: z.string().min(1).max(63),
          token: z.string().min(1).max(200),
        }),
        response: {
          202: z.object({ id: z.string(), duplicate: z.boolean() }),
          401: ErrorSchema,
          404: ErrorSchema,
          503: ErrorSchema,
        },
      },
      handler: async (request, reply) => {
        const webhooks = ctx.core?.webhooks;
        if (!webhooks) return reply.status(503).send({ error: "Unavailable" });
        try {
          const received = await webhooks.ingest({
            ...request.params,
            headers: request.headers,
            body: Buffer.isBuffer(request.body)
              ? request.body
              : Buffer.alloc(0),
          });
          return reply
            .status(202)
            .send({ id: received.eventId, duplicate: received.duplicate });
        } catch (error) {
          if (error instanceof WebhookNotFoundError)
            return reply.status(404).send({ error: error.message });
          if (error instanceof WebhookRejectedError)
            return reply.status(401).send({ error: error.message });
          throw error;
        }
      },
    });
  });

  typed.route({
    method: "GET",
    url: "/projects/:projectId/webhooks",
    schema: {
      params: ProjectIdParamsSchema,
      response: { 200: z.array(WebhookSchema), 503: ErrorSchema },
    },
    handler: async (request, reply) => {
      const webhooks = ctx.core?.webhooks;
      if (!webhooks) return reply.status(503).send({ error: "Unavailable" });
      const endpoints = await webhooks.list({
        identity: resolveIdentity(request),
        projectId: request.params.projectId,
      });
      const base = apiBase(request);
      return reply.send(
        endpoints.map(({ path, ...endpoint }) => ({
          ...endpoint,
          url: `${base}${path}`,
        })),
      );
    },
  });

  typed.route({
    method: "POST",
    url: "/projects/:projectId/webhooks/:name/rotate",
    schema: {
      params: ProjectIdParamsSchema.extend({ name: z.string().min(1) }),
      response: { 200: WebhookSchema, 404: ErrorSchema, 503: ErrorSchema },
    },
    handler: async (request, reply) => {
      const webhooks = ctx.core?.webhooks;
      if (!webhooks) return reply.status(503).send({ error: "Unavailable" });
      try {
        const { path, ...endpoint } = await webhooks.rotate({
          identity: resolveIdentity(request),
          projectId: request.params.projectId,
          name: request.params.name,
        });
        return reply.send({ ...endpoint, url: `${apiBase(request)}${path}` });
      } catch (error) {
        if (error instanceof WebhookNotFoundError)
          return reply.status(404).send({ error: error.message });
        throw error;
      }
    },
  });
}
