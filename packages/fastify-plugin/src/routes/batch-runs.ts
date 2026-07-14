import {
  BatchItemNotFoundError,
  BatchRunNotFoundError,
  BatchWorkflowRequiredError,
  PluginSecretsMissingError,
  ProductionDeploymentNotFoundError,
  ProjectNotFoundError,
  WorkflowNotFoundError,
} from "@catamorphic/core";
import type { Json } from "@catamorphic/db";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { RouteContext } from "../app.js";
import { resolveIdentity } from "../http-identity.js";
import {
  BatchItemIdParamsSchema,
  BatchItemSchema,
  BatchItemStepSchema,
  BatchItemsQuerySchema,
  BatchRunIdParamsSchema,
  BatchRunSchema,
  BatchRunsQuerySchema,
  ErrorSchema,
  ListSchema,
  TriggerBatchRunSchema,
  WorkflowNameParamsSchema,
} from "../schemas.js";

export function registerBatchRunRoutes(
  app: FastifyInstance,
  ctx: RouteContext,
): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.route({
    method: "POST",
    url: "/projects/:projectId/workflows/:name/batch-runs",
    schema: {
      params: WorkflowNameParamsSchema,
      body: TriggerBatchRunSchema,
      response: {
        201: BatchRunSchema,
        400: ErrorSchema,
        404: ErrorSchema,
        409: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!ctx.core) {
        return reply.status(503).send({ error: "Service not configured" });
      }
      const identity = resolveIdentity(request);
      try {
        const batchRun = await ctx.core.batchRuns.triggerProduction({
          identity,
          projectId: request.params.projectId,
          workflowName: request.params.name,
          triggerData: optionalJson(request.body.triggerData),
          failurePolicy: request.body.failurePolicy,
        });
        return reply.status(201).send(batchRun);
      } catch (error) {
        if (
          error instanceof ProjectNotFoundError ||
          error instanceof WorkflowNotFoundError
        ) {
          return reply.status(404).send({ error: error.message });
        }
        if (error instanceof ProductionDeploymentNotFoundError) {
          return reply.status(409).send({ error: error.message });
        }
        if (error instanceof BatchWorkflowRequiredError) {
          return reply.status(409).send({ error: error.message });
        }
        if (error instanceof PluginSecretsMissingError) {
          return reply.status(400).send({ error: error.message });
        }
        throw error;
      }
    },
  });

  typed.route({
    method: "GET",
    url: "/batch-runs/:batchRunId/items/:itemId/steps",
    schema: {
      params: BatchItemIdParamsSchema,
      response: {
        200: z.array(BatchItemStepSchema),
        404: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!ctx.core) {
        return reply.status(503).send({ error: "Service not configured" });
      }
      const identity = resolveIdentity(request);
      try {
        const steps = await ctx.core.batchRuns.listItemSteps({
          identity,
          batchRunId: request.params.batchRunId,
          itemId: request.params.itemId,
        });
        return reply.send(steps);
      } catch (error) {
        if (
          error instanceof BatchRunNotFoundError ||
          error instanceof BatchItemNotFoundError
        ) {
          return reply.status(404).send({ error: error.message });
        }
        throw error;
      }
    },
  });

  typed.route({
    method: "GET",
    url: "/projects/:projectId/workflows/:name/batch-runs",
    schema: {
      params: WorkflowNameParamsSchema,
      querystring: BatchRunsQuerySchema,
      response: {
        200: ListSchema(BatchRunSchema),
        404: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!ctx.core) {
        return reply.status(503).send({ error: "Service not configured" });
      }
      const identity = resolveIdentity(request);
      try {
        const result = await ctx.core.batchRuns.list({
          identity,
          projectId: request.params.projectId,
          workflowName: request.params.name,
          limit: request.query.limit,
          offset: request.query.offset,
        });
        return reply.send(result);
      } catch (error) {
        if (error instanceof ProjectNotFoundError) {
          return reply.status(404).send({ error: error.message });
        }
        throw error;
      }
    },
  });

  typed.route({
    method: "GET",
    url: "/batch-runs/:batchRunId",
    schema: {
      params: BatchRunIdParamsSchema,
      response: {
        200: BatchRunSchema,
        404: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!ctx.core) {
        return reply.status(503).send({ error: "Service not configured" });
      }
      const identity = resolveIdentity(request);
      try {
        const batchRun = await ctx.core.batchRuns.get({
          identity,
          batchRunId: request.params.batchRunId,
        });
        return reply.send(batchRun);
      } catch (error) {
        if (error instanceof BatchRunNotFoundError) {
          return reply.status(404).send({ error: error.message });
        }
        throw error;
      }
    },
  });

  typed.route({
    method: "GET",
    url: "/batch-runs/:batchRunId/items",
    schema: {
      params: BatchRunIdParamsSchema,
      querystring: BatchItemsQuerySchema,
      response: {
        200: ListSchema(BatchItemSchema),
        404: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!ctx.core) {
        return reply.status(503).send({ error: "Service not configured" });
      }
      const identity = resolveIdentity(request);
      try {
        const result = await ctx.core.batchRuns.listItems({
          identity,
          batchRunId: request.params.batchRunId,
          status: request.query.status,
          limit: request.query.limit,
          offset: request.query.offset,
        });
        return reply.send(result);
      } catch (error) {
        if (error instanceof BatchRunNotFoundError) {
          return reply.status(404).send({ error: error.message });
        }
        throw error;
      }
    },
  });

  typed.route({
    method: "POST",
    url: "/batch-runs/:batchRunId/pause",
    schema: {
      params: BatchRunIdParamsSchema,
      response: {
        200: BatchRunSchema,
        404: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!ctx.core) {
        return reply.status(503).send({ error: "Service not configured" });
      }
      const identity = resolveIdentity(request);
      try {
        const batchRun = await ctx.core.batchRuns.pause({
          identity,
          batchRunId: request.params.batchRunId,
        });
        return reply.send(batchRun);
      } catch (error) {
        if (error instanceof BatchRunNotFoundError) {
          return reply.status(404).send({ error: error.message });
        }
        throw error;
      }
    },
  });

  typed.route({
    method: "POST",
    url: "/batch-runs/:batchRunId/resume",
    schema: {
      params: BatchRunIdParamsSchema,
      response: {
        200: BatchRunSchema,
        404: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!ctx.core) {
        return reply.status(503).send({ error: "Service not configured" });
      }
      const identity = resolveIdentity(request);
      try {
        const batchRun = await ctx.core.batchRuns.resume({
          identity,
          batchRunId: request.params.batchRunId,
        });
        return reply.send(batchRun);
      } catch (error) {
        if (error instanceof BatchRunNotFoundError) {
          return reply.status(404).send({ error: error.message });
        }
        throw error;
      }
    },
  });

  typed.route({
    method: "POST",
    url: "/batch-runs/:batchRunId/cancel",
    schema: {
      params: BatchRunIdParamsSchema,
      response: {
        200: BatchRunSchema,
        404: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!ctx.core) {
        return reply.status(503).send({ error: "Service not configured" });
      }
      const identity = resolveIdentity(request);
      try {
        const batchRun = await ctx.core.batchRuns.cancel({
          identity,
          batchRunId: request.params.batchRunId,
        });
        return reply.send(batchRun);
      } catch (error) {
        if (error instanceof BatchRunNotFoundError) {
          return reply.status(404).send({ error: error.message });
        }
        throw error;
      }
    },
  });

  typed.route({
    method: "POST",
    url: "/batch-runs/:batchRunId/retry-failed",
    schema: {
      params: BatchRunIdParamsSchema,
      response: {
        200: BatchRunSchema,
        404: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!ctx.core) {
        return reply.status(503).send({ error: "Service not configured" });
      }
      const identity = resolveIdentity(request);
      try {
        const batchRun = await ctx.core.batchRuns.retryFailedItems({
          identity,
          batchRunId: request.params.batchRunId,
        });
        return reply.send(batchRun);
      } catch (error) {
        if (error instanceof BatchRunNotFoundError) {
          return reply.status(404).send({ error: error.message });
        }
        throw error;
      }
    },
  });
}

function optionalJson(value: unknown): Json | undefined {
  if (value === undefined) return undefined;
  if (!isJson(value)) {
    throw new Error("Request value is not JSON serializable");
  }
  return value;
}

function isJson(value: unknown): value is Json {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(isJson);
  }
  if (typeof value !== "object") return false;
  return Object.values(value).every(
    (entry) => entry === undefined || isJson(entry),
  );
}
