import {
  RunCapabilityError,
  RunNotFoundError,
  RunPauseNotFoundError,
  RunResumeConflictError,
} from "@catamorphic/core";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { RouteContext } from "../app.js";
import { resolveIdentity } from "../http-identity.js";
import {
  BatchItemSchema,
  BatchItemStepSchema,
  CancelRunSchema,
  ErrorSchema,
  ListSchema,
  ResumeRunPauseSchema,
  RunDetailSchema,
  RunIdParamsSchema,
  RunItemParamsSchema,
  RunItemsQuerySchema,
  RunPauseParamsSchema,
  RunSchema,
  RunStepAttemptParamsSchema,
} from "../schemas.js";

export function registerRunRoutes(app: FastifyInstance, ctx: RouteContext) {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.route({
    method: "GET",
    url: "/runs/:runId",
    schema: {
      params: RunIdParamsSchema,
      response: { 200: RunDetailSchema, 404: ErrorSchema, 503: ErrorSchema },
    },
    handler: async (request, reply) => {
      if (!ctx.core)
        return reply.status(503).send({ error: "Service not configured" });
      try {
        return reply.send(
          await ctx.core.runs.get({
            identity: resolveIdentity(request),
            runId: request.params.runId,
          }),
        );
      } catch (error) {
        if (error instanceof RunNotFoundError) {
          return reply.status(404).send({ error: error.message });
        }
        throw error;
      }
    },
  });

  typed.route({
    method: "POST",
    url: "/runs/:runId/cancel",
    schema: {
      params: RunIdParamsSchema,
      body: CancelRunSchema,
      response: {
        200: RunSchema,
        404: ErrorSchema,
        409: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!ctx.core)
        return reply.status(503).send({ error: "Service not configured" });
      try {
        return reply.send(
          await ctx.core.runs.cancel({
            identity: resolveIdentity(request),
            runId: request.params.runId,
            reason: request.body.reason,
          }),
        );
      } catch (error) {
        return handleRunError({ error, reply });
      }
    },
  });

  typed.route({
    method: "POST",
    url: "/runs/:runId/pause",
    schema: {
      params: RunIdParamsSchema,
      response: {
        200: RunSchema,
        404: ErrorSchema,
        409: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!ctx.core)
        return reply.status(503).send({ error: "Service not configured" });
      try {
        return reply.send(
          await ctx.core.runs.pause({
            identity: resolveIdentity(request),
            runId: request.params.runId,
          }),
        );
      } catch (error) {
        return handleRunError({ error, reply });
      }
    },
  });

  typed.route({
    method: "POST",
    url: "/runs/:runId/resume",
    schema: {
      params: RunIdParamsSchema,
      response: {
        200: RunSchema,
        404: ErrorSchema,
        409: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!ctx.core)
        return reply.status(503).send({ error: "Service not configured" });
      try {
        return reply.send(
          await ctx.core.runs.resume({
            identity: resolveIdentity(request),
            runId: request.params.runId,
          }),
        );
      } catch (error) {
        return handleRunError({ error, reply });
      }
    },
  });

  typed.route({
    method: "POST",
    url: "/runs/:runId/pauses/:pauseId/resume",
    schema: {
      params: RunPauseParamsSchema,
      body: ResumeRunPauseSchema,
      response: {
        200: RunSchema,
        404: ErrorSchema,
        409: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!ctx.core)
        return reply.status(503).send({ error: "Service not configured" });
      try {
        return reply.send(
          await ctx.core.runs.resumePause({
            identity: resolveIdentity(request),
            runId: request.params.runId,
            pauseId: request.params.pauseId,
            idempotencyKey: request.body.idempotencyKey,
            value: request.body.value,
          }),
        );
      } catch (error) {
        return handleRunError({ error, reply });
      }
    },
  });

  typed.route({
    method: "GET",
    url: "/runs/:runId/steps/:workflowStepAttemptId/items",
    schema: {
      params: RunStepAttemptParamsSchema,
      querystring: RunItemsQuerySchema,
      response: {
        200: ListSchema(BatchItemSchema),
        404: ErrorSchema,
        409: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!ctx.core)
        return reply.status(503).send({ error: "Service not configured" });
      try {
        return reply.send(
          await ctx.core.runs.listItems({
            identity: resolveIdentity(request),
            runId: request.params.runId,
            workflowStepAttemptId: request.params.workflowStepAttemptId,
            status: request.query.status,
            limit: request.query.limit,
            offset: request.query.offset,
          }),
        );
      } catch (error) {
        return handleRunError({ error, reply });
      }
    },
  });

  typed.route({
    method: "GET",
    url: "/runs/:runId/steps/:workflowStepAttemptId/items/:itemId/steps",
    schema: {
      params: RunItemParamsSchema,
      response: {
        200: z.array(BatchItemStepSchema),
        404: ErrorSchema,
        409: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!ctx.core)
        return reply.status(503).send({ error: "Service not configured" });
      try {
        return reply.send(
          await ctx.core.runs.listItemSteps({
            identity: resolveIdentity(request),
            runId: request.params.runId,
            workflowStepAttemptId: request.params.workflowStepAttemptId,
            itemId: request.params.itemId,
          }),
        );
      } catch (error) {
        return handleRunError({ error, reply });
      }
    },
  });
}

function handleRunError(args: { error: unknown; reply: FastifyReply }) {
  if (
    args.error instanceof RunNotFoundError ||
    args.error instanceof RunPauseNotFoundError
  ) {
    return args.reply.status(404).send({ error: args.error.message });
  }
  if (
    args.error instanceof RunCapabilityError ||
    args.error instanceof RunResumeConflictError
  ) {
    return args.reply.status(409).send({ error: args.error.message });
  }
  throw args.error;
}
