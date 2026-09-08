import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { RouteContext } from "../app.js";
import { resolveIdentity } from "../http-identity.js";
import { ErrorSchema, OkSchema } from "../schemas.js";

const PushConfigSchema = z.object({
  enabled: z.boolean(),
  publicKey: z.string().nullable(),
});

const PushSubscriptionSchema = z.object({
  endpoint: z.string().url(),
  expirationTime: z.number().int().nullable(),
  keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
});

const PushUnsubscribeSchema = z.object({ endpoint: z.string().url() });

export function registerNotificationRoutes(
  app: FastifyInstance,
  ctx: RouteContext,
) {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.get(
    "/notifications/push/config",
    { schema: { response: { 200: PushConfigSchema, 503: ErrorSchema } } },
    async (_request, reply) => {
      if (!ctx.core) {
        return reply
          .status(503)
          .send({ error: "Notifications not configured" });
      }
      return reply.send(ctx.core.notifications.pushConfig);
    },
  );

  typed.put(
    "/notifications/push/subscription",
    {
      schema: {
        body: PushSubscriptionSchema,
        response: { 200: OkSchema, 409: ErrorSchema, 503: ErrorSchema },
      },
    },
    async (request, reply) => {
      if (!ctx.core?.notifications.transport) {
        return reply.status(409).send({ error: "Push is not enabled" });
      }
      await ctx.core.notifications.subscribe(resolveIdentity(request), {
        ...request.body,
        userAgent: request.headers["user-agent"],
      });
      return reply.send({ ok: true });
    },
  );

  typed.delete(
    "/notifications/push/subscription",
    {
      schema: {
        body: PushUnsubscribeSchema,
        response: { 200: OkSchema, 503: ErrorSchema },
      },
    },
    async (request, reply) => {
      if (!ctx.core) {
        return reply
          .status(503)
          .send({ error: "Notifications not configured" });
      }
      await ctx.core.notifications.unsubscribe(
        resolveIdentity(request),
        request.body.endpoint,
      );
      return reply.send({ ok: true });
    },
  );
}
