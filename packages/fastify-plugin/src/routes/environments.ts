import { AccessDeniedError, AgentNotConfiguredError } from "@catamorphic/core";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
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
      try {
        const agent = request.query.agentId
          ? await ctx.core?.agentSessions?.getAgent({
              identity,
              projectId: request.params.projectId,
              agentId: request.query.agentId,
            })
          : undefined;
        if (request.query.agentId && !agent)
          return reply.status(404).send({ error: "Agent not configured" });
        const result = await service.discover({
          identity,
          projectId: request.params.projectId,
          requirements: {
            ...agent?.environment?.requirements,
            workload: request.query.workload,
            ...(agent ? { topology: agent.topology } : {}),
          },
          allowed: agent?.environment?.allowed,
          preferred: agent?.environment?.preferred,
        });
        return reply.send(EnvironmentListSchema.parse(result));
      } catch (error) {
        if (error instanceof AgentNotConfiguredError)
          return reply.status(404).send({ error: error.message });
        if (error instanceof AccessDeniedError) {
          return reply.status(403).send({ error: error.message });
        }
        throw error;
      }
    },
  });
}
