import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  ErrorSchema,
  ListSchema,
  PaginationQuerySchema,
  ProjectIdParamsSchema,
  RefQuerySchema,
  RunSchema,
  TriggerRunSchema,
  WorkflowGraphSchema,
  WorkflowNameParamsSchema,
  WorkflowSummarySchema,
} from "../schemas.js";

export function registerWorkflowRoutes(app: FastifyInstance) {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.route({
    method: "GET",
    url: "/api/projects/:projectId/workflows",
    schema: {
      params: ProjectIdParamsSchema,
      querystring: RefQuerySchema,
      response: {
        200: WorkflowSummarySchema.array(),
        404: ErrorSchema,
      },
    },
    handler: async (_request, reply) => {
      return reply.status(404).send({ error: "Not found" });
    },
  });

  typed.route({
    method: "GET",
    url: "/api/projects/:projectId/workflows/:name",
    schema: {
      params: WorkflowNameParamsSchema,
      querystring: RefQuerySchema,
      response: { 200: WorkflowGraphSchema, 404: ErrorSchema },
    },
    handler: async (_request, reply) => {
      return reply.status(404).send({ error: "Not found" });
    },
  });

  typed.route({
    method: "POST",
    url: "/api/projects/:projectId/workflows/:name/runs",
    schema: {
      params: WorkflowNameParamsSchema,
      body: TriggerRunSchema,
      response: { 201: RunSchema, 404: ErrorSchema },
    },
    handler: async (_request, reply) => {
      return reply.status(404).send({ error: "Not found" });
    },
  });

  typed.route({
    method: "GET",
    url: "/api/projects/:projectId/workflows/:name/runs",
    schema: {
      params: WorkflowNameParamsSchema,
      querystring: PaginationQuerySchema,
      response: { 200: ListSchema(RunSchema), 404: ErrorSchema },
    },
    handler: async (_request, reply) => {
      return reply.send({ items: [], total: 0 });
    },
  });
}
