import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  CreateRunSchema,
  CreateWorkflowSchema,
  ErrorSchema,
  ListSchema,
  ParseResultSchema,
  UpdateWorkflowSchema,
  WorkflowIdParamsSchema,
  WorkflowRunSchema,
  WorkflowSchema,
} from "../schemas.js";

export function registerWorkflowRoutes(
  app: FastifyInstance & {
    withTypeProvider: () => ReturnType<FastifyInstance["withTypeProvider"]>;
  },
) {
  const typed = (app as FastifyInstance).withTypeProvider<ZodTypeProvider>();

  typed.route({
    method: "POST",
    url: "/api/workflows",
    schema: {
      body: CreateWorkflowSchema,
      response: {
        201: WorkflowSchema,
        400: ErrorSchema,
      },
    },
    handler: async (_request, reply) => {
      return reply.status(501).send({ error: "Not implemented" });
    },
  });

  typed.route({
    method: "GET",
    url: "/api/workflows",
    schema: {
      response: {
        200: ListSchema(WorkflowSchema),
      },
    },
    handler: async (_request, reply) => {
      return reply.send({ items: [], total: 0 });
    },
  });

  typed.route({
    method: "GET",
    url: "/api/workflows/:id",
    schema: {
      params: WorkflowIdParamsSchema,
      response: {
        200: WorkflowSchema,
        404: ErrorSchema,
      },
    },
    handler: async (_request, reply) => {
      return reply.status(404).send({ error: "Not found" });
    },
  });

  typed.route({
    method: "PUT",
    url: "/api/workflows/:id",
    schema: {
      params: WorkflowIdParamsSchema,
      body: UpdateWorkflowSchema,
      response: {
        200: WorkflowSchema,
        404: ErrorSchema,
      },
    },
    handler: async (_request, reply) => {
      return reply.status(404).send({ error: "Not found" });
    },
  });

  typed.route({
    method: "DELETE",
    url: "/api/workflows/:id",
    schema: {
      params: WorkflowIdParamsSchema,
      response: {
        404: ErrorSchema,
      },
    },
    handler: async (_request, reply) => {
      return reply.status(404).send({ error: "Not found" });
    },
  });

  typed.route({
    method: "POST",
    url: "/api/workflows/:id/parse",
    schema: {
      params: WorkflowIdParamsSchema,
      response: {
        200: ParseResultSchema,
        404: ErrorSchema,
      },
    },
    handler: async (_request, reply) => {
      return reply.status(404).send({ error: "Not found" });
    },
  });

  typed.route({
    method: "POST",
    url: "/api/workflows/:id/run",
    schema: {
      params: WorkflowIdParamsSchema,
      body: CreateRunSchema,
      response: {
        201: WorkflowRunSchema,
        404: ErrorSchema,
      },
    },
    handler: async (_request, reply) => {
      return reply.status(404).send({ error: "Not found" });
    },
  });

  typed.route({
    method: "GET",
    url: "/api/workflows/:id/runs",
    schema: {
      params: WorkflowIdParamsSchema,
      response: {
        200: ListSchema(WorkflowRunSchema),
        404: ErrorSchema,
      },
    },
    handler: async (_request, reply) => {
      return reply.send({ items: [], total: 0 });
    },
  });
}
