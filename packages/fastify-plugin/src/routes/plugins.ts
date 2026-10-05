import {
  assertProjectPermission,
  PluginNotAttachedError,
  SecretDeclarationConflictError,
  SecretMemberNotFoundError,
  SecretValueInvalidError,
  UndeclaredSecretError,
  UnfulfilledCapabilityError,
} from "@catamorphic/core";
import { PluginResolutionError } from "@catamorphic/plugins";
import type { FastifyInstance, FastifyRequest } from "fastify";
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
  SecretMemberParamsSchema,
  SecretNameParamsSchema,
  SecretStatusSchema,
  SecretValueChangeSchema,
  UpsertSecretSchema,
} from "../schemas.js";

/** A refused secret write the person can fix: a 400 or 404, not a fault. */
function secretWriteError(
  error: unknown,
): { status: 400 | 404; message: string } | undefined {
  if (error instanceof SecretMemberNotFoundError)
    return { status: 404, message: error.message };
  if (
    error instanceof UndeclaredSecretError ||
    error instanceof SecretDeclarationConflictError ||
    error instanceof SecretValueInvalidError ||
    error instanceof PluginNotAttachedError
  )
    return { status: 400, message: error.message };
  return undefined;
}

export function registerPluginRoutes(app: FastifyInstance, ctx: RouteContext) {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  async function requirePublish(request: FastifyRequest, projectId: string) {
    const identity = resolveIdentity(request);
    await ctx.core?.projects.get(identity, projectId);
    assertProjectPermission(identity, projectId, "program:publish");
  }

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
      // Reading the project's plugins is reading its program.
      await ctx.core.projects.get(
        resolveIdentity(request),
        request.params.projectId,
      );
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
      // Attached plugins reach live runs at once: publishing the program.
      await requirePublish(request, request.params.projectId);
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
      await requirePublish(request, request.params.projectId);
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
      });
      return reply.send(list);
    },
  });

  typed.route({
    method: "PUT",
    url: "/projects/:projectId/secrets/:name",
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
      if (!ctx.core?.secrets)
        return reply.status(503).send({ error: "Secrets not configured" });
      try {
        const status = await ctx.core.secrets.upsert({
          identity: resolveIdentity(request),
          projectId: request.params.projectId,
          name: request.params.name,
          value: request.body.value,
        });
        return reply.send(status);
      } catch (err) {
        const refused = secretWriteError(err);
        if (refused?.status === 400)
          return reply.status(400).send({ error: refused.message });
        throw err;
      }
    },
  });

  // A member's own value (ADR 0205): set by the member (`me`) or by anyone
  // holding `secrets:write`.
  typed.route({
    method: "PUT",
    url: "/projects/:projectId/secrets/:name/members/:member",
    schema: {
      params: SecretMemberParamsSchema,
      body: UpsertSecretSchema,
      response: {
        200: SecretValueChangeSchema,
        400: ErrorSchema,
        404: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!ctx.core?.secrets)
        return reply.status(503).send({ error: "Secrets not configured" });
      const identity = resolveIdentity(request);
      try {
        const change = await ctx.core.secrets.setMember({
          identity,
          projectId: request.params.projectId,
          name: request.params.name,
          member:
            request.params.member === "me"
              ? identity.externalUserId
              : request.params.member,
          value: request.body.value,
        });
        return reply.send(change);
      } catch (err) {
        const refused = secretWriteError(err);
        if (refused?.status === 400)
          return reply.status(400).send({ error: refused.message });
        if (refused?.status === 404)
          return reply.status(404).send({ error: refused.message });
        throw err;
      }
    },
  });

  typed.route({
    method: "DELETE",
    url: "/projects/:projectId/secrets/:name/members/:member",
    schema: {
      params: SecretMemberParamsSchema,
      response: {
        200: z.object({ deleted: z.boolean() }),
        400: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!ctx.core?.secrets)
        return reply.status(503).send({ error: "Secrets not configured" });
      const identity = resolveIdentity(request);
      try {
        const deleted = await ctx.core.secrets.deleteMember({
          identity,
          projectId: request.params.projectId,
          name: request.params.name,
          member:
            request.params.member === "me"
              ? identity.externalUserId
              : request.params.member,
        });
        return reply.send({ deleted });
      } catch (err) {
        const refused = secretWriteError(err);
        if (refused?.status === 400)
          return reply.status(400).send({ error: refused.message });
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
        name: request.params.name,
      });
      return reply.send({ deleted: ok });
    },
  });
}
