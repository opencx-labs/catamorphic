import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { ErrorSchema, RunIdParamsSchema, RunStatusSchema } from "../schemas.js";

export function registerRunRoutes(
  app: FastifyInstance & {
    withTypeProvider: () => ReturnType<FastifyInstance["withTypeProvider"]>;
  },
) {
  const typed = (app as FastifyInstance).withTypeProvider<ZodTypeProvider>();

  typed.route({
    method: "GET",
    url: "/api/runs/:runId",
    schema: {
      params: RunIdParamsSchema,
      response: {
        200: RunStatusSchema,
        404: ErrorSchema,
      },
    },
    handler: async (_request, reply) => {
      return reply.status(404).send({ error: "Not found" });
    },
  });
}
