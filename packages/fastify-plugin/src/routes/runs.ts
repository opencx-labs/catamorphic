import { RunNotFoundError } from "@catamorphic/core";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { RouteContext } from "../app.js";
import { resolveIdentity } from "../http-identity.js";
import {
  ErrorSchema,
  RunDetailSchema,
  RunIdParamsSchema,
  RunReportSchema,
  RunSchema,
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
      const identity = resolveIdentity(request);
      try {
        const run = await ctx.core.runs.get(identity, request.params.runId);
        return reply.send(run);
      } catch (err) {
        if (err instanceof RunNotFoundError) {
          return reply.status(404).send({ error: "Run not found" });
        }
        throw err;
      }
    },
  });

  typed.route({
    method: "POST",
    url: "/runs/:runId/cancel",
    schema: {
      params: RunIdParamsSchema,
      response: {
        200: RunSchema,
        404: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!ctx.core)
        return reply.status(503).send({ error: "Service not configured" });
      const identity = resolveIdentity(request);
      try {
        const run = await ctx.core.runs.cancel({
          identity,
          runId: request.params.runId,
        });
        return reply.send(run);
      } catch (error) {
        if (error instanceof RunNotFoundError) {
          return reply.status(404).send({ error: "Run not found" });
        }
        throw error;
      }
    },
  });

  typed.route({
    method: "POST",
    url: "/runs/:runId/report",
    schema: {
      params: RunIdParamsSchema,
      body: RunReportSchema,
      response: {
        200: RunDetailSchema,
        400: ErrorSchema,
        404: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!ctx.core)
        return reply.status(503).send({ error: "Service not configured" });
      if (request.body.runId !== request.params.runId) {
        return reply.status(400).send({ error: "Run ID does not match path" });
      }
      const identity = resolveIdentity(request);
      try {
        const run = await ctx.core.runs.report({
          identity,
          runId: request.params.runId,
          result: {
            status: request.body.status,
            result: request.body.result,
            error: request.body.error,
            steps: request.body.steps,
          },
        });
        return reply.send(run);
      } catch (error) {
        if (error instanceof RunNotFoundError) {
          return reply.status(404).send({ error: "Run not found" });
        }
        throw error;
      }
    },
  });
}
