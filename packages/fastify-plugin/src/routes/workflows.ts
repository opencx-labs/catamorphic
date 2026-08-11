import {
  InvalidRunOverlayError,
  PluginSecretsMissingError,
  ProductionDeploymentNotFoundError,
  ProjectNotFoundError,
  RunCapabilityError,
  RunEnrollmentConflictError,
  RunResumeConflictError,
  RunSignalNotFoundError,
  SandboxProviderNotConfiguredError,
  TenantActiveRunLimitError,
  WorkflowNotFoundError,
} from "@catamorphic/core";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { RouteContext } from "../app.js";
import { resolveIdentity } from "../http-identity.js";
import {
  CancelRunByKeySchema,
  ErrorSchema,
  ListSchema,
  RefQuerySchema,
  RunSchema,
  RunsQuerySchema,
  SignalRunSchema,
  TriggerRunSchema,
  TriggerTestRunSchema,
  WorkflowDetailSchema,
  WorkflowNameParamsSchema,
  WorkflowSummarySchema,
} from "../schemas.js";
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
        404: ErrorSchema,
        409: ErrorSchema,
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
        if (err instanceof ProjectNotFoundError) {
          return reply.status(404).send({ error: "Project not found" });
        }
        if (err instanceof WorkflowNotFoundError) {
          return reply.status(404).send({ error: "Workflow not found" });
        }
        if (err instanceof ProductionDeploymentNotFoundError) {
          return reply.status(409).send({ error: err.message });
        }
        if (err instanceof RunEnrollmentConflictError) {
          return reply.status(409).send({ error: err.message });
        }
        if (err instanceof TenantActiveRunLimitError) {
          return reply.status(429).send({ error: err.message });
        }
        if (err instanceof RunCapabilityError) {
          return reply.status(409).send({ error: err.message });
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
    method: "POST",
    url: "/projects/:projectId/workflows/:name/test-runs",
    schema: {
      params: WorkflowNameParamsSchema,
      body: TriggerTestRunSchema,
      response: {
        201: RunSchema,
        400: ErrorSchema,
        404: ErrorSchema,
        409: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!ctx.core)
        return reply.status(503).send({ error: "Service not configured" });
      const identity = resolveIdentity(request);
      try {
        const run = await ctx.core.runs.triggerTest({
          identity,
          projectId: request.params.projectId,
          workflowName: request.params.name,
          input: request.body.input,
          files: request.body.files,
        });
        return reply.status(201).send(run);
      } catch (err) {
        if (err instanceof ProjectNotFoundError) {
          return reply.status(404).send({ error: "Project not found" });
        }
        if (err instanceof WorkflowNotFoundError) {
          return reply.status(404).send({ error: "Workflow not found" });
        }
        if (
          err instanceof PluginSecretsMissingError ||
          err instanceof InvalidRunOverlayError
        ) {
          return reply.status(400).send({ error: err.message });
        }
        if (err instanceof RunCapabilityError) {
          return reply.status(409).send({ error: err.message });
        }
        if (err instanceof SandboxProviderNotConfiguredError) {
          return reply.status(503).send({
            error: "Sandbox provider not configured",
          });
        }
        throw err;
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
          mode: request.query.mode,
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
