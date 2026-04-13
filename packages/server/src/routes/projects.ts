import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  CommitSchema,
  CreateProjectSchema,
  ErrorSchema,
  FileContentSchema,
  FileEntrySchema,
  ListSchema,
  PaginationQuerySchema,
  ProjectDetailSchema,
  ProjectIdParamsSchema,
  ProjectSchema,
  SetRemoteSchema,
  UpdateProjectSchema,
} from "../schemas.js";

export function registerProjectRoutes(
  app: FastifyInstance,
  _projectManager?: import("@catamorphic/git").ProjectManager,
) {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.route({
    method: "POST",
    url: "/api/projects",
    schema: {
      body: CreateProjectSchema,
      response: { 201: ProjectSchema, 400: ErrorSchema },
    },
    handler: async (_request, reply) => {
      return reply.status(400).send({ error: "Not implemented" });
    },
  });

  typed.route({
    method: "GET",
    url: "/api/projects",
    schema: {
      querystring: PaginationQuerySchema,
      response: { 200: ListSchema(ProjectSchema) },
    },
    handler: async (_request, reply) => {
      return reply.send({ items: [], total: 0 });
    },
  });

  typed.route({
    method: "GET",
    url: "/api/projects/:projectId",
    schema: {
      params: ProjectIdParamsSchema,
      response: { 200: ProjectDetailSchema, 404: ErrorSchema },
    },
    handler: async (_request, reply) => {
      return reply.status(404).send({ error: "Not found" });
    },
  });

  typed.route({
    method: "PATCH",
    url: "/api/projects/:projectId",
    schema: {
      params: ProjectIdParamsSchema,
      body: UpdateProjectSchema,
      response: { 200: ProjectSchema, 404: ErrorSchema },
    },
    handler: async (_request, reply) => {
      return reply.status(404).send({ error: "Not found" });
    },
  });

  typed.route({
    method: "DELETE",
    url: "/api/projects/:projectId",
    schema: {
      params: ProjectIdParamsSchema,
      response: { 404: ErrorSchema },
    },
    handler: async (_request, reply) => {
      return reply.status(404).send({ error: "Not found" });
    },
  });

  typed.route({
    method: "GET",
    url: "/api/projects/:projectId/files",
    schema: {
      params: ProjectIdParamsSchema,
      response: {
        200: FileEntrySchema.array(),
        404: ErrorSchema,
      },
    },
    handler: async (_request, reply) => {
      return reply.status(404).send({ error: "Not found" });
    },
  });

  typed.route({
    method: "GET",
    url: "/api/projects/:projectId/files/*",
    schema: {
      params: ProjectIdParamsSchema,
      response: { 200: FileContentSchema, 404: ErrorSchema },
    },
    handler: async (_request, reply) => {
      return reply.status(404).send({ error: "Not found" });
    },
  });

  typed.route({
    method: "PUT",
    url: "/api/projects/:projectId/files/*",
    schema: {
      params: ProjectIdParamsSchema,
      response: { 200: FileContentSchema, 404: ErrorSchema },
    },
    handler: async (_request, reply) => {
      return reply.status(404).send({ error: "Not found" });
    },
  });

  typed.route({
    method: "DELETE",
    url: "/api/projects/:projectId/files/*",
    schema: {
      params: ProjectIdParamsSchema,
      response: { 404: ErrorSchema },
    },
    handler: async (_request, reply) => {
      return reply.status(404).send({ error: "Not found" });
    },
  });

  typed.route({
    method: "GET",
    url: "/api/projects/:projectId/commits",
    schema: {
      params: ProjectIdParamsSchema,
      querystring: PaginationQuerySchema,
      response: { 200: ListSchema(CommitSchema), 404: ErrorSchema },
    },
    handler: async (_request, reply) => {
      return reply.status(404).send({ error: "Not found" });
    },
  });

  typed.route({
    method: "POST",
    url: "/api/projects/:projectId/remote",
    schema: {
      params: ProjectIdParamsSchema,
      body: SetRemoteSchema,
      response: { 200: ProjectSchema, 404: ErrorSchema },
    },
    handler: async (_request, reply) => {
      return reply.status(404).send({ error: "Not found" });
    },
  });

  typed.route({
    method: "POST",
    url: "/api/projects/:projectId/push",
    schema: {
      params: ProjectIdParamsSchema,
      response: { 404: ErrorSchema },
    },
    handler: async (_request, reply) => {
      return reply.status(404).send({ error: "Not found" });
    },
  });

  typed.route({
    method: "POST",
    url: "/api/projects/:projectId/pull",
    schema: {
      params: ProjectIdParamsSchema,
      response: { 404: ErrorSchema },
    },
    handler: async (_request, reply) => {
      return reply.status(404).send({ error: "Not found" });
    },
  });

  typed.route({
    method: "POST",
    url: "/api/projects/:projectId/export",
    schema: {
      params: ProjectIdParamsSchema,
      response: { 404: ErrorSchema },
    },
    handler: async (_request, reply) => {
      return reply.status(404).send({ error: "Not found" });
    },
  });
}
