import { layoutGraph, parseWorkflowFromProject } from "@catamorphic/parser";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { RouteContext } from "../app.js";
import {
  PlaygroundParseRequestSchema,
  PlaygroundParseResponseSchema,
} from "../schemas.js";
import { attachTriggerKindDisplays } from "./triggers.js";

export function registerPlaygroundRoutes(
  app: FastifyInstance,
  ctx: RouteContext,
) {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.route({
    method: "POST",
    url: "/playground/parse",
    schema: {
      body: PlaygroundParseRequestSchema,
      response: { 200: PlaygroundParseResponseSchema },
    },
    handler: async (request, reply) => {
      const { files, workflowName, preferredFilePath } = request.body;
      const graph = parseWorkflowFromProject(files, workflowName, {
        preferredFilePath,
      });
      if (!graph) return reply.send(null);
      layoutGraph({ nodes: graph.nodes, edges: graph.edges });
      return reply.send(attachTriggerKindDisplays(ctx.core, graph));
    },
  });
}
