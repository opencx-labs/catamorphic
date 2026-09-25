import { layoutGraph, parseWorkflowFromProject } from "@catamorphic/parser";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { RouteContext } from "../app.js";
import {
  ParseWorkflowRequestSchema,
  ParseWorkflowResponseSchema,
} from "../schemas.js";
import { attachTriggerKindDisplays } from "./triggers.js";

/** Parse in-flight draft files into a graph (the browser cannot run the parser). */
export function registerParseRoutes(app: FastifyInstance, ctx: RouteContext) {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.route({
    method: "POST",
    url: "/workflows/parse",
    schema: {
      body: ParseWorkflowRequestSchema,
      response: { 200: ParseWorkflowResponseSchema },
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
