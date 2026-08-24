import {
  ProjectNotFoundError,
  RunCapabilityError,
  RunResumeConflictError,
  RunSignalNotFoundError,
  WorkflowNotFoundError,
} from "@catamorphic/core";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { RouteContext } from "../app.js";
import { resolveIdentity } from "../http-identity.js";
import {
  AuthenticationRequiredSchema,
  CallRunSchema,
  CancelRunByKeySchema,
  ErrorSchema,
  ListSchema,
  RefQuerySchema,
  RunCallOutcomeSchema,
  RunSchema,
  RunsQuerySchema,
  SignalRunSchema,
  TriggerRunSchema,
  WorkflowDetailSchema,
  WorkflowNameParamsSchema,
  WorkflowSummarySchema,
} from "../schemas.js";
import { replyForTriggerError } from "./run-errors.js";
import { attachTriggerKindDisplays } from "./triggers.js";

export function registerWorkflowRoutes(
  app: FastifyInstance,
  ctx: RouteContext,
) {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.route({
    method: "GET",
    url: "/projects/:projectId/workflows",
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
      const identity = resolveIdentity(request);
      try {
        const workflows = await ctx.core.workflows.list({
          identity,
          projectId: request.params.projectId,
          ref: request.query.ref,
        });
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
    url: "/projects/:projectId/workflows/:name",
    schema: {
      params: WorkflowNameParamsSchema,
      querystring: RefQuerySchema,
      response: {
        200: WorkflowDetailSchema,
        404: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!ctx.core)
        return reply.status(503).send({ error: "Service not configured" });
      const identity = resolveIdentity(request);
      const { projectId, name } = request.params;
      const { ref } = request.query;
      try {
        const graph = await ctx.core.workflows.get({
          identity,
          projectId,
          workflowName: name,
          ref,
        });
        return reply.send(attachTriggerKindDisplays(ctx.core, graph));
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
    url: "/projects/:projectId/workflows/:name/runs",
    schema: {
      params: WorkflowNameParamsSchema,
      body: TriggerRunSchema,
      response: {
        201: RunSchema,
        400: ErrorSchema,
        403: ErrorSchema,
        404: ErrorSchema,
        409: ErrorSchema,
        422: ErrorSchema,
        428: AuthenticationRequiredSchema,
        429: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!ctx.core)
        return reply.status(503).send({ error: "Service not configured" });
      const identity = resolveIdentity(request);
      try {
        const run = await ctx.core.runs.triggerProduction({
          identity,
          projectId: request.params.projectId,
          workflowName: request.params.name,
          environment: request.body.environment,
          input: request.body.input,
          ...(request.body.correlationKey === undefined
            ? {}
            : { correlationKey: request.body.correlationKey }),
          ...(request.body.onConflict === undefined
            ? {}
            : { onConflict: request.body.onConflict }),
        });
        return reply.status(201).send(run);
      } catch (err) {
        return replyForTriggerError(err, reply) ?? Promise.reject(err);
      }
    },
  });

  typed.route({
    method: "POST",
    url: "/projects/:projectId/workflows/:name/calls",
    schema: {
      params: WorkflowNameParamsSchema,
      body: CallRunSchema,
      response: {
        200: RunCallOutcomeSchema,
        400: ErrorSchema,
        403: ErrorSchema,
        404: ErrorSchema,
        409: ErrorSchema,
        422: ErrorSchema,
        428: AuthenticationRequiredSchema,
        429: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!ctx.core)
        return reply.status(503).send({ error: "Service not configured" });
      try {
        // Sync is a calling mode, not a workflow kind: the run is triggered
        // exactly like an async one and driven inline until it settles or
        // reaches a durable wait, at which point `suspended` hands the run
        // id back for polling.
        const outcome = await ctx.core.runs.call({
          identity: resolveIdentity(request),
          projectId: request.params.projectId,
          workflowName: request.params.name,
          environment: request.body.environment,
          input: request.body.input,
          ...(request.body.correlationKey === undefined
            ? {}
            : { correlationKey: request.body.correlationKey }),
          ...(request.body.onConflict === undefined
            ? {}
            : { onConflict: request.body.onConflict }),
          ...(request.body.budgetMs === undefined
            ? {}
            : { budgetMs: request.body.budgetMs }),
        });
        return reply.send(outcome);
      } catch (err) {
        return replyForTriggerError(err, reply) ?? Promise.reject(err);
      }
    },
  });

  typed.route({
    method: "GET",
    url: "/projects/:projectId/workflows/:name/runs",
    schema: {
      params: WorkflowNameParamsSchema,
      querystring: RunsQuerySchema,
      response: {
        200: ListSchema(RunSchema),
        404: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!ctx.core)
        return reply.status(503).send({ error: "Service not configured" });
      const identity = resolveIdentity(request);
      const { projectId, name } = request.params;
      try {
        const result = await ctx.core.runs.list({
          identity,
          projectId,
          workflowName: name,
          limit: request.query.limit,
          offset: request.query.offset,
          ...(request.query.correlationKey === undefined
            ? {}
            : { correlationKey: request.query.correlationKey }),
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

  typed.route({
    method: "POST",
    url: "/projects/:projectId/workflows/:name/signals",
    schema: {
      params: WorkflowNameParamsSchema,
      body: SignalRunSchema,
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
          await ctx.core.runs.signalByKey({
            identity: resolveIdentity(request),
            projectId: request.params.projectId,
            workflowName: request.params.name,
            correlationKey: request.body.correlationKey,
            signal: request.body.signal,
            idempotencyKey: request.body.idempotencyKey,
            value: request.body.value,
          }),
        );
      } catch (err) {
        if (err instanceof ProjectNotFoundError) {
          return reply.status(404).send({ error: "Project not found" });
        }
        if (err instanceof RunSignalNotFoundError) {
          return reply.status(404).send({ error: err.message });
        }
        // The pause can time out or be cancelled between resolving it and
        // resuming it, which is a conflict the caller can retry against — not
        // a server fault.
        if (
          err instanceof RunResumeConflictError ||
          err instanceof RunCapabilityError
        ) {
          return reply.status(409).send({ error: err.message });
        }
        throw err;
      }
    },
  });

  typed.route({
    method: "POST",
    url: "/projects/:projectId/workflows/:name/cancellations",
    schema: {
      params: WorkflowNameParamsSchema,
      body: CancelRunByKeySchema,
      response: {
        200: RunSchema,
        204: z.null(),
        404: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!ctx.core)
        return reply.status(503).send({ error: "Service not configured" });
      try {
        const run = await ctx.core.runs.cancelByKey({
          identity: resolveIdentity(request),
          projectId: request.params.projectId,
          workflowName: request.params.name,
          correlationKey: request.body.correlationKey,
          ...(request.body.reason === undefined
            ? {}
            : { reason: request.body.reason }),
        });
        // A repeated opt-out is a no-op, not an error.
        return run ? reply.send(run) : reply.status(204).send(null);
      } catch (err) {
        if (err instanceof ProjectNotFoundError) {
          return reply.status(404).send({ error: "Project not found" });
        }
        throw err;
      }
    },
  });
}
