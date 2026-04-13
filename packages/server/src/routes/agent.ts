import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  AgentMessageSchema,
  AgentSessionDetailSchema,
  AgentSessionIdParamsSchema,
  AgentSessionSchema,
  CreateAgentSessionSchema,
  ErrorSchema,
  ListSchema,
  PaginationQuerySchema,
  ProjectIdParamsSchema,
  SendMessageSchema,
} from "../schemas.js";

export function registerAgentRoutes(app: FastifyInstance) {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.route({
    method: "POST",
    url: "/api/projects/:projectId/agent/sessions",
    schema: {
      params: ProjectIdParamsSchema,
      body: CreateAgentSessionSchema,
      response: { 201: AgentSessionSchema, 404: ErrorSchema },
    },
    handler: async (_request, reply) => {
      return reply.status(404).send({ error: "Not implemented" });
    },
  });

  typed.route({
    method: "GET",
    url: "/api/projects/:projectId/agent/sessions",
    schema: {
      params: ProjectIdParamsSchema,
      querystring: PaginationQuerySchema,
      response: { 200: ListSchema(AgentSessionSchema), 404: ErrorSchema },
    },
    handler: async (_request, reply) => {
      return reply.send({ items: [], total: 0 });
    },
  });

  typed.route({
    method: "GET",
    url: "/api/projects/:projectId/agent/sessions/:sessionId",
    schema: {
      params: AgentSessionIdParamsSchema,
      response: { 200: AgentSessionDetailSchema, 404: ErrorSchema },
    },
    handler: async (_request, reply) => {
      return reply.status(404).send({ error: "Not found" });
    },
  });

  typed.route({
    method: "POST",
    url: "/api/projects/:projectId/agent/sessions/:sessionId/messages",
    schema: {
      params: AgentSessionIdParamsSchema,
      body: SendMessageSchema,
      response: { 201: AgentMessageSchema, 404: ErrorSchema },
    },
    handler: async (_request, reply) => {
      return reply.status(404).send({ error: "Not implemented" });
    },
  });

  typed.route({
    method: "DELETE",
    url: "/api/projects/:projectId/agent/sessions/:sessionId",
    schema: {
      params: AgentSessionIdParamsSchema,
      response: { 200: AgentSessionSchema, 404: ErrorSchema },
    },
    handler: async (_request, reply) => {
      return reply.status(404).send({ error: "Not found" });
    },
  });
}
