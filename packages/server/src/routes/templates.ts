import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { TemplateSchema } from "../schemas.js";
import { TEMPLATES } from "../templates.js";

export function registerTemplateRoutes(app: FastifyInstance) {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.route({
    method: "GET",
    url: "/api/templates",
    schema: {
      response: { 200: TemplateSchema.array() },
    },
    handler: async (_request, reply) => {
      return reply.send(
        TEMPLATES.map((t) => ({
          id: t.id,
          name: t.name,
          description: t.description,
          defaultWorkflow: t.defaultWorkflow,
          fileCount: Object.keys(t.files).filter(
            (f) => f.endsWith(".ts") || f.endsWith(".tsx"),
          ).length,
        })),
      );
    },
  });
}
