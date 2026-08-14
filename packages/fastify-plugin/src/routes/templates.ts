import { TEMPLATES } from "@catamorphic/core";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { RouteContext } from "../plugin.js";
import { TemplateSchema } from "../schemas.js";

export function registerTemplateRoutes(
  app: FastifyInstance,
  ctx: RouteContext,
) {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.route({
    method: "GET",
    url: "/templates",
    schema: {
      response: { 200: TemplateSchema.array() },
    },
    handler: async (_request, reply) => {
      // The host-resolved template set (ADR 0049); the framework defaults
      // only when no core is wired.
      const templates = ctx.core?.projects.listTemplates() ?? TEMPLATES;
      return reply.send(
        templates.map((t) => ({
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
