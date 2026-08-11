import {
  ProductionDeploymentNotFoundError,
  ProjectNotFoundError,
  RunEnrollmentConflictError,
  RunInputInvalidError,
  TenantActiveRunLimitError,
  TriggerBindingsInvalidError,
  TriggerKindNotRegisteredError,
  TriggerModeNotAllowedError,
  TriggerPayloadInvalidError,
} from "@catamorphic/core";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { RouteContext } from "../app.js";
import { resolveIdentity } from "../http-identity.js";
import {
  ErrorSchema,
  FireTriggerSchema,
  SyncTriggerTypesResultSchema,
  TriggerBindingInfoSchema,
  TriggerFireResultSchema,
  TriggerKindInfoSchema,
} from "../schemas.js";

const ProjectParamsSchema = z.object({ projectId: z.string() });

/**
 * Resolves each graph trigger binding's display metadata from the host's
 * registered kinds. Serving-layer concern: the parser only knows kind names.
 */
export function attachTriggerKindDisplays<
  Graph extends {
    nodes: Array<{
      triggerBindings?: Array<{
        kind: string;
        display?: { label?: string; icon?: string; color?: string };
      }>;
    }>;
  },
>(core: RouteContext["core"], graph: Graph): Graph {
  if (!core) return graph;
  for (const node of graph.nodes) {
    for (const binding of node.triggerBindings ?? []) {
      const display = core.triggers.kindInfo(binding.kind)?.display;
      if (display) binding.display = display;
    }
  }
  return graph;
}

export function registerTriggerRoutes(app: FastifyInstance, ctx: RouteContext) {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.route({
    method: "GET",
    url: "/trigger-kinds",
    schema: {
      response: { 200: TriggerKindInfoSchema.array(), 503: ErrorSchema },
    },
    handler: async (_request, reply) => {
      if (!ctx.core)
        return reply.status(503).send({ error: "Service not configured" });
      return reply.send(
        ctx.core.triggers.listKinds() as unknown as z.infer<
          typeof TriggerKindInfoSchema
        >[],
      );
    },
  });

  typed.route({
    method: "GET",
    url: "/projects/:projectId/triggers",
    schema: {
      params: ProjectParamsSchema,
      querystring: z.object({ kind: z.string().optional() }),
      response: {
        200: TriggerBindingInfoSchema.array(),
        404: ErrorSchema,
        422: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!ctx.core)
        return reply.status(503).send({ error: "Service not configured" });
      const identity = resolveIdentity(request);
      try {
        const bindings = await ctx.core.triggers.list({
          identity,
          projectId: request.params.projectId,
          kind: request.query.kind,
        });
        return reply.send(
          bindings as unknown as z.infer<typeof TriggerBindingInfoSchema>[],
        );
      } catch (err) {
        return handleTriggerError(err, reply) as never;
      }
    },
  });

  typed.route({
    method: "POST",
    url: "/projects/:projectId/triggers/:kind/fire",
    schema: {
      params: ProjectParamsSchema.extend({ kind: z.string() }),
      body: FireTriggerSchema,
      response: {
        200: TriggerFireResultSchema,
        404: ErrorSchema,
        409: ErrorSchema,
        422: ErrorSchema,
        429: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!ctx.core)
        return reply.status(503).send({ error: "Service not configured" });
      const identity = resolveIdentity(request);
      try {
        const result = await ctx.core.triggers.fire({
          identity,
          projectId: request.params.projectId,
          kind: request.params.kind,
          payload: request.body.payload ?? null,
          mode: request.body.mode,
          workflows: request.body.workflows,
          correlationKey: request.body.correlationKey,
          onConflict: request.body.onConflict,
          budgetMs: request.body.budgetMs,
        });
        // The core's readonly Json and zod's JSONType are structurally
        // identical but not mutually assignable.
        return reply.send(
          result as unknown as z.infer<typeof TriggerFireResultSchema>,
        );
      } catch (err) {
        if (err instanceof RunEnrollmentConflictError) {
          return reply.status(409).send({ error: err.message });
        }
        if (err instanceof TenantActiveRunLimitError) {
          return reply.status(429).send({ error: err.message });
        }
        return handleTriggerError(err, reply) as never;
      }
    },
  });

  typed.route({
    method: "POST",
    url: "/projects/:projectId/triggers/sync-types",
    schema: {
      params: ProjectParamsSchema,
      response: {
        200: SyncTriggerTypesResultSchema,
        404: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!ctx.core)
        return reply.status(503).send({ error: "Service not configured" });
      const identity = resolveIdentity(request);
      try {
        const result = await ctx.core.triggers.syncTypes({
          identity,
          projectId: request.params.projectId,
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

function handleTriggerError(
  err: unknown,
  reply: {
    status(code: number): { send(body: { error: string }): unknown };
  },
): unknown {
  if (err instanceof ProjectNotFoundError) {
    return reply.status(404).send({ error: "Project not found" });
  }
  if (err instanceof ProductionDeploymentNotFoundError) {
    return reply.status(404).send({ error: err.message });
  }
  if (
    err instanceof RunInputInvalidError ||
    err instanceof TriggerKindNotRegisteredError ||
    err instanceof TriggerModeNotAllowedError ||
    err instanceof TriggerPayloadInvalidError ||
    err instanceof TriggerBindingsInvalidError
  ) {
    return reply.status(422).send({ error: err.message });
  }
  throw err;
}
