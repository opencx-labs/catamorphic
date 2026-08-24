import {
  PluginNotAttachedError,
  UndeclaredSecretError,
  UnfulfilledCapabilityError,
} from "@catamorphic/core";
import { PluginResolutionError } from "@catamorphic/plugins";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { RouteContext } from "../app.js";
import { resolveIdentity } from "../http-identity.js";
import {
  AttachedPluginSchema,
  AttachPluginSchema,
  CatalogPluginSchema,
  ErrorSchema,
  PluginPackageParamsSchema,
  ProjectIdParamsSchema,
  RunStageQuerySchema,
  SecretNameParamsSchema,
  SecretStatusSchema,
  UpsertSecretSchema,
} from "../schemas.js";

export function registerPluginRoutes(app: FastifyInstance, ctx: RouteContext) {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.route({
    method: "GET",
    url: "/plugins/catalog",
    schema: {
      response: {
        200: z.array(CatalogPluginSchema),
        503: ErrorSchema,
      },
    },
    handler: async (_request, reply) => {
      if (!ctx.core?.plugins)
        return reply.status(503).send({ error: "Plugins not configured" });
      const catalog = await ctx.core.plugins.listCatalog();
      return reply.send(catalog);
    },
  });

  typed.route({
    method: "GET",
    url: "/projects/:projectId/plugins",
    schema: {
      params: ProjectIdParamsSchema,
      response: {
        200: z.array(AttachedPluginSchema),
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!ctx.core?.plugins)
        return reply.status(503).send({ error: "Plugins not configured" });
      const attached = await ctx.core.plugins.listAttached(
        request.params.projectId,
      );
      return reply.send(attached);
    },
  });

  typed.route({
    method: "POST",
    url: "/projects/:projectId/plugins",
    schema: {
      params: ProjectIdParamsSchema,
      body: AttachPluginSchema,
      response: {
        201: AttachedPluginSchema,
        400: ErrorSchema,
        404: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!ctx.core?.plugins)
        return reply.status(503).send({ error: "Plugins not configured" });
      try {
        const attached = await ctx.core.plugins.attach(
          request.params.projectId,
          request.body.packageName,
        );
        return reply.status(201).send(attached);
      } catch (err) {
        if (err instanceof PluginResolutionError) {
          return reply.status(404).send({ error: err.message });
        }
        // Fail-closed attach (ADR 0046): a required capability with no
        // registered provider is a host configuration problem, not a 500.
        if (err instanceof UnfulfilledCapabilityError) {
          return reply.status(400).send({ error: err.message });
        }
        throw err;
      }
    },
  });

  typed.route({
    method: "DELETE",
    url: "/projects/:projectId/plugins/:packageName",
    schema: {
      params: PluginPackageParamsSchema,
      response: {
        200: z.object({ detached: z.boolean() }),
        404: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!ctx.core?.plugins)
        return reply.status(503).send({ error: "Plugins not configured" });
      const ok = await ctx.core.plugins.detach(
        request.params.projectId,
        decodeURIComponent(request.params.packageName),
      );
      if (!ok) {
        return reply
          .status(404)
          .send({ error: "Plugin not attached to project" });
      }
      return reply.send({ detached: true });
    },
  });

  typed.route({
    method: "GET",
    url: "/projects/:projectId/secrets",
    schema: {
      params: ProjectIdParamsSchema,
      querystring: RunStageQuerySchema,
      response: {
        200: z.array(SecretStatusSchema),
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!ctx.core?.secrets)
        return reply.status(503).send({ error: "Secrets not configured" });
      const list = await ctx.core.secrets.list({
        identity: resolveIdentity(request),
        projectId: request.params.projectId,
        stage: request.query.stage,
      });
      return reply.send(list);
    },
  });

  typed.route({
    method: "PUT",
    url: "/projects/:projectId/secrets/:name",
    schema: {
      params: SecretNameParamsSchema,
      querystring: RunStageQuerySchema,
      body: UpsertSecretSchema,
      response: {
        200: SecretStatusSchema,
        400: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!ctx.core?.secrets)
        return reply.status(503).send({ error: "Secrets not configured" });
      try {
        const status = await ctx.core.secrets.upsert({
          identity: resolveIdentity(request),
          projectId: request.params.projectId,
          stage: request.query.stage,
          name: request.params.name,
          value: request.body.value,
        });
        return reply.send(status);
      } catch (err) {
        if (
          err instanceof UndeclaredSecretError ||
          err instanceof PluginNotAttachedError
        ) {
          return reply.status(400).send({ error: err.message });
        }
        throw err;
      }
    },
  });

  typed.route({
    method: "GET",
    url: "/projects/:projectId/agent-context",
    schema: {
      params: ProjectIdParamsSchema,
      response: {
        200: z.object({ systemPromptSuffix: z.string() }),
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!ctx.core?.agentContext)
        return reply.status(503).send({ error: "Plugins not configured" });
      const systemPromptSuffix = await ctx.core.agentContext.buildPrompt(
        request.params.projectId,
      );
      return reply.send({ systemPromptSuffix });
    },
  });

  typed.route({
    method: "DELETE",
    url: "/projects/:projectId/secrets/:name",
    schema: {
      params: SecretNameParamsSchema,
      querystring: RunStageQuerySchema,
      response: {
        200: z.object({ deleted: z.boolean() }),
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!ctx.core?.secrets)
        return reply.status(503).send({ error: "Secrets not configured" });
      const ok = await ctx.core.secrets.delete({
        identity: resolveIdentity(request),
        projectId: request.params.projectId,
        stage: request.query.stage,
        name: request.params.name,
      });
      return reply.send({ deleted: ok });
    },
  });
}
