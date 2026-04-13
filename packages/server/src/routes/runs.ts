import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  ErrorSchema,
  RunDetailSchema,
  RunIdParamsSchema,
  RunSchema,
} from "../schemas.js";

export function registerRunRoutes(app: FastifyInstance) {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.route({
    method: "GET",
    url: "/api/runs/:runId",
    schema: {
      params: RunIdParamsSchema,
      response: { 200: RunDetailSchema, 404: ErrorSchema },
    },
    handler: async (_request, reply) => {
      return reply.status(404).send({ error: "Not found" });
    },
  });

  typed.route({
    method: "POST",
    url: "/api/runs/:runId/cancel",
    schema: {
      params: RunIdParamsSchema,
      response: { 200: RunSchema, 404: ErrorSchema },
    },
    handler: async (_request, reply) => {
      return reply.status(404).send({ error: "Not found" });
    },
  });
}
