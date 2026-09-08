import {
  AccessDeniedError,
  ClientRunnerOperationSchema,
  ClientRunnerResultSchema,
} from "@catamorphic/core";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { RouteContext } from "../app.js";
import { resolveIdentity } from "../http-identity.js";
import { ErrorSchema, ProjectIdParamsSchema } from "../schemas.js";

const Lease = z.object({ id: z.string().uuid(), token: z.string().uuid() });
export function registerClientRunnerRoutes(
  app: FastifyInstance,
  ctx: RouteContext,
) {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.post(
    "/projects/:projectId/client-runners",
    {
      schema: {
        params: ProjectIdParamsSchema,
        body: z.object({
          id: z.string().uuid(),
          environment: z.string().min(1),
          label: z.string().min(1).max(100),
          workspaceRoot: z.string().min(1).max(4096),
          resourceLimits: z
            .array(z.enum(["cpuMillis", "memoryMb", "storageMb", "gpu"]))
            .optional(),
          isolation: z.enum(["none", "process", "sandbox"]).optional(),
        }),
        response: {
          200: Lease,
          403: ErrorSchema,
          409: ErrorSchema,
          503: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      if (!ctx.core?.clientRunners)
        return reply
          .status(503)
          .send({ error: "Client execution is not enabled by this host" });
      try {
        return reply.send(
          await ctx.core.clientRunners.register({
            ...request.body,
            projectId: request.params.projectId,
            identity: resolveIdentity(request),
          }),
        );
      } catch (error) {
        if (error instanceof AccessDeniedError)
          return reply.status(403).send({ error: error.message });
        return reply.status(409).send({
          error:
            error instanceof Error
              ? error.message
              : "Client registration failed",
        });
      }
    },
  );
  typed.post(
    "/client-runners/poll",
    {
      schema: {
        body: Lease,
        response: {
          200: z
            .object({
              id: z.string().uuid(),
              operation: ClientRunnerOperationSchema,
            })
            .nullable(),
          403: ErrorSchema,
          503: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      if (!ctx.core?.clientRunners)
        return reply
          .status(503)
          .send({ error: "Client execution is not enabled by this host" });
      return reply.send(
        await ctx.core.clientRunners.poll({
          ...request.body,
          identity: resolveIdentity(request),
        }),
      );
    },
  );
  typed.post(
    "/client-runners/renew",
    {
      schema: {
        body: Lease,
        response: {
          200: z.object({ ok: z.boolean() }),
          403: ErrorSchema,
          503: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      if (!ctx.core?.clientRunners)
        return reply
          .status(503)
          .send({ error: "Client execution is not enabled by this host" });
      await ctx.core.clientRunners.renew({
        ...request.body,
        identity: resolveIdentity(request),
      });
      return { ok: true };
    },
  );
  typed.post(
    "/client-runners/complete",
    {
      schema: {
        body: Lease.extend({
          jobId: z.string().uuid(),
          response: ClientRunnerResultSchema.optional(),
          error: z.string().max(4000).optional(),
        }),
        response: {
          200: z.object({ ok: z.boolean() }),
          403: ErrorSchema,
          409: ErrorSchema,
          503: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      if (!ctx.core?.clientRunners)
        return reply
          .status(503)
          .send({ error: "Client execution is not enabled by this host" });
      return reply.send(
        await ctx.core.clientRunners.complete({
          ...request.body,
          identity: resolveIdentity(request),
        }),
      );
    },
  );
  typed.post(
    "/client-runners/disconnect",
    {
      schema: {
        body: Lease,
        response: {
          200: z.object({ ok: z.boolean() }),
          403: ErrorSchema,
          503: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      if (!ctx.core?.clientRunners)
        return reply
          .status(503)
          .send({ error: "Client execution is not enabled by this host" });
      await ctx.core.clientRunners.disconnect({
        ...request.body,
        identity: resolveIdentity(request),
      });
      return { ok: true };
    },
  );
}
