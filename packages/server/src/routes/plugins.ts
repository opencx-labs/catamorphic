import { PluginResolutionError } from "@catamorphic/plugins";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  AttachedPluginSchema,
  AttachPluginSchema,
  CatalogPluginSchema,
  ErrorSchema,
  PluginPackageParamsSchema,
  ProjectIdParamsSchema,
  SecretNameParamsSchema,
  SecretStatusSchema,
  UpsertSecretSchema,
} from "../schemas.js";
import type { AgentContextService } from "../services/agent-context-service.js";
import {
  PluginNotAttachedError,
  type PluginsService,
  UndeclaredSecretError,
} from "../services/plugins-service.js";
import type { SecretsService } from "../services/secrets-service.js";

export function registerPluginRoutes(
  app: FastifyInstance,
  plugins?: PluginsService,
  secrets?: SecretsService,
  agentContext?: AgentContextService,
) {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.route({
    method: "GET",
    url: "/api/plugins/catalog",
    schema: {
      response: {
        200: z.array(CatalogPluginSchema),
        503: ErrorSchema,
      },
    },
    handler: async (_request, reply) => {
      if (!plugins)
        return reply.status(503).send({ error: "Plugins not configured" });
      const catalog = await plugins.listCatalog();
      return reply.send(catalog);
    },
  });

  typed.route({
    method: "GET",
    url: "/api/projects/:projectId/plugins",
    schema: {
      params: ProjectIdParamsSchema,
      response: {
        200: z.array(AttachedPluginSchema),
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!plugins)
        return reply.status(503).send({ error: "Plugins not configured" });
      const attached = await plugins.listAttached(request.params.projectId);
      return reply.send(attached);
    },
  });

  typed.route({
    method: "POST",
    url: "/api/projects/:projectId/plugins",
    schema: {
      params: ProjectIdParamsSchema,
      body: AttachPluginSchema,
      response: {
        201: AttachedPluginSchema,
        404: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!plugins)
        return reply.status(503).send({ error: "Plugins not configured" });
      try {
        const attached = await plugins.attach(
          request.params.projectId,
          request.body.packageName,
        );
        return reply.status(201).send(attached);
      } catch (err) {
        if (err instanceof PluginResolutionError) {
          return reply.status(404).send({ error: err.message });
        }
        throw err;
      }
    },
  });

  typed.route({
    method: "DELETE",
    url: "/api/projects/:projectId/plugins/:packageName",
    schema: {
      params: PluginPackageParamsSchema,
      response: {
        200: z.object({ detached: z.boolean() }),
        404: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!plugins)
        return reply.status(503).send({ error: "Plugins not configured" });
      const ok = await plugins.detach(
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
    url: "/api/projects/:projectId/secrets",
    schema: {
      params: ProjectIdParamsSchema,
      response: {
        200: z.array(SecretStatusSchema),
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!secrets)
        return reply.status(503).send({ error: "Secrets not configured" });
      const list = await secrets.list(request.params.projectId);
      return reply.send(list);
    },
  });

  typed.route({
    method: "PUT",
    url: "/api/projects/:projectId/secrets/:name",
    schema: {
      params: SecretNameParamsSchema,
      body: UpsertSecretSchema,
      response: {
        200: SecretStatusSchema,
        400: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!secrets)
        return reply.status(503).send({ error: "Secrets not configured" });
      try {
        const status = await secrets.upsert(
          request.params.projectId,
          request.params.name,
          request.body.value,
        );
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
    url: "/api/projects/:projectId/agent-context",
    schema: {
      params: ProjectIdParamsSchema,
      response: {
        200: z.object({ systemPromptSuffix: z.string() }),
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!agentContext)
        return reply.status(503).send({ error: "Plugins not configured" });
      const systemPromptSuffix = await agentContext.buildPrompt(
        request.params.projectId,
      );
      return reply.send({ systemPromptSuffix });
    },
  });

  typed.route({
    method: "DELETE",
    url: "/api/projects/:projectId/secrets/:name",
    schema: {
      params: SecretNameParamsSchema,
      response: {
        200: z.object({ deleted: z.boolean() }),
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!secrets)
        return reply.status(503).send({ error: "Secrets not configured" });
      const ok = await secrets.delete(
        request.params.projectId,
        request.params.name,
      );
      return reply.send({ deleted: ok });
    },
  });
}
