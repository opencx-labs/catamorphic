import { AccessDeniedError } from "@catamorphic/core";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { z } from "zod";
import type { RouteContext } from "../app.js";
import { resolveIdentity } from "../http-identity.js";
import {
  EnvironmentListQuerySchema,
  EnvironmentListSchema,
  ErrorSchema,
  ProjectIdParamsSchema,
} from "../schemas.js";

export function registerEnvironmentRoutes(
  app: FastifyInstance,
  ctx: RouteContext,
): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.route({
    method: "GET",
    url: "/projects/:projectId/environments",
    schema: {
      params: ProjectIdParamsSchema,
      querystring: EnvironmentListQuerySchema,
      response: {
        200: EnvironmentListSchema,
        403: ErrorSchema,
        404: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      const service = ctx.core?.executionEnvironments;
      if (!service) {
        return reply
          .status(503)
          .send({ error: "Environment provider not configured" });
      }
      const identity = resolveIdentity(request);
      let allowed: readonly string[] | undefined;
      let preferred: readonly string[] | undefined;
      if (request.query.agentId) {
        const entry = (
          await ctx.core?.agentDefinitions.list(
            identity,
            request.params.projectId,
          )
        )?.find((candidate) => candidate.slug === request.query.agentId);
        allowed = entry?.definition?.environment?.allowed;
        preferred = entry?.definition?.environment?.preferred;
      }
      try {
        const result = await service.discover({
          identity,
          projectId: request.params.projectId,
          requirements: {
            workload: request.query.workload,
          },
          ...(allowed ? { allowed } : {}),
          ...(preferred ? { preferred } : {}),
        });
        return reply.send(
          result as unknown as z.infer<typeof EnvironmentListSchema>,
        );
      } catch (error) {
        if (error instanceof AccessDeniedError) {
          return reply.status(403).send({ error: error.message });
        }
        throw error;
      }
    },
  });
}
