import {
  PluginSecretsMissingError,
  ProjectNotFoundError,
  SandboxProviderNotConfiguredError,
  WorkflowNotFoundError,
} from "@catamorphic/core";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { RouteContext } from "../app.js";
import { resolveIdentity } from "../http-identity.js";
import {
  ErrorSchema,
  ListSchema,
  PaginationQuerySchema,
  RefQuerySchema,
  RunSchema,
  TriggerRunSchema,
  WorkflowGraphSchema,
  WorkflowNameParamsSchema,
  WorkflowSummarySchema,
} from "../schemas.js";

export function registerWorkflowRoutes(
  app: FastifyInstance,
  ctx: RouteContext,
) {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.route({
    method: "GET",
    url: "/api/projects/:projectId/workflows",
    schema: {
      params: WorkflowNameParamsSchema.pick({ projectId: true }),
      querystring: RefQuerySchema,
      response: {
        200: WorkflowSummarySchema.array(),
        404: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!ctx.core)
        return reply.status(503).send({ error: "Service not configured" });
      const identity = resolveIdentity(request, { standalone: ctx.standalone });
      try {
        const workflows = await ctx.core.workflows.list(
          identity,
          request.params.projectId,
        );
        return reply.send(workflows);
      } catch (err) {
        if (err instanceof ProjectNotFoundError) {
          return reply.status(404).send({ error: "Project not found" });
        }
        throw err;
      }
    },
  });

  typed.route({
    method: "GET",
    url: "/api/projects/:projectId/workflows/:name",
    schema: {
      params: WorkflowNameParamsSchema,
      querystring: RefQuerySchema,
      response: {
        200: WorkflowGraphSchema,
        404: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!ctx.core)
        return reply.status(503).send({ error: "Service not configured" });
      const identity = resolveIdentity(request, { standalone: ctx.standalone });
      const { projectId, name } = request.params;
      const { ref } = request.query;
      try {
        const graph = await ctx.core.workflows.get(identity, projectId, name, {
          ref,
        });
        return reply.send(graph);
      } catch (err) {
        if (err instanceof ProjectNotFoundError) {
          return reply.status(404).send({ error: "Project not found" });
        }
        if (err instanceof WorkflowNotFoundError) {
          return reply.status(404).send({ error: "Workflow not found" });
        }
        throw err;
      }
    },
  });

  typed.route({
    method: "POST",
    url: "/api/projects/:projectId/workflows/:name/runs",
    schema: {
      params: WorkflowNameParamsSchema,
      body: TriggerRunSchema,
      response: {
        201: RunSchema,
        400: ErrorSchema,
        404: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!ctx.core)
        return reply.status(503).send({ error: "Service not configured" });
      const identity = resolveIdentity(request, { standalone: ctx.standalone });
      try {
        const run = await ctx.core.runs.trigger(
          identity,
          request.params.projectId,
          request.params.name,
          request.body,
        );
        return reply.status(201).send(run);
      } catch (err) {
        if (err instanceof ProjectNotFoundError) {
          return reply.status(404).send({ error: "Project not found" });
        }
        if (err instanceof WorkflowNotFoundError) {
          return reply.status(404).send({ error: "Workflow not found" });
        }
        if (err instanceof PluginSecretsMissingError) {
          return reply.status(400).send({ error: err.message });
        }
        if (err instanceof SandboxProviderNotConfiguredError) {
          return reply.status(503).send({
            error:
              "Sandbox provider not configured. Set CLOUDFLARE_SANDBOX_API_URL and CLOUDFLARE_SANDBOX_API_KEY (recommended) or DAYTONA_API_KEY to enable workflow execution.",
          });
        }
        throw err;
      }
    },
  });

  typed.route({
    method: "GET",
    url: "/api/projects/:projectId/workflows/:name/runs",
    schema: {
      params: WorkflowNameParamsSchema,
      querystring: PaginationQuerySchema,
      response: {
        200: ListSchema(RunSchema),
        404: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!ctx.core)
        return reply.status(503).send({ error: "Service not configured" });
      const identity = resolveIdentity(request, { standalone: ctx.standalone });
      const { projectId, name } = request.params;
      try {
        const result = await ctx.core.runs.list(identity, projectId, {
          workflowName: name,
          limit: request.query.limit,
          offset: request.query.offset,
        });
        return reply.send(result);
      } catch (err) {
        if (err instanceof ProjectNotFoundError) {
          return reply.status(404).send({ error: "Project not found" });
        }
        throw err;
      }
    },
  });
}
