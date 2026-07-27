import {
  AppBuildFailedError,
  AppBundleTooLargeError,
  AppNotFoundError,
  AppPublishStateError,
  AppVersionNotFoundError,
} from "@catamorphic/core";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { RouteContext } from "../app.js";
import { resolveIdentity } from "../http-identity.js";
import {
  AppSummarySchema,
  AppVersionSchema,
  AppViewStateSchema,
  BuildAppSchema,
  ErrorSchema,
  ProjectAppParamsSchema,
  ProjectAppVersionParamsSchema,
  ProjectIdParamsSchema,
} from "../schemas.js";

export function registerAppRoutes(app: FastifyInstance, ctx: RouteContext) {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.route({
    method: "GET",
    url: "/projects/:projectId/apps",
    schema: {
      params: ProjectIdParamsSchema,
      response: { 200: z.array(AppSummarySchema), 503: ErrorSchema },
    },
    handler: async (request, reply) => {
      if (!ctx.core?.apps)
        return reply.status(503).send({ error: "Apps not configured" });
      const list = await ctx.core.apps.list({
        identity: resolveIdentity(request),
        projectId: request.params.projectId,
      });
      return reply.send(list);
    },
  });

  typed.route({
    method: "GET",
    url: "/projects/:projectId/apps/:appName/versions",
    schema: {
      params: ProjectAppParamsSchema,
      response: { 200: z.array(AppVersionSchema), 503: ErrorSchema },
    },
    handler: async (request, reply) => {
      if (!ctx.core?.apps)
        return reply.status(503).send({ error: "Apps not configured" });
      const versions = await ctx.core.apps.listVersions({
        identity: resolveIdentity(request),
        projectId: request.params.projectId,
        appName: request.params.appName,
      });
      return reply.send(versions);
    },
  });

  typed.route({
    method: "POST",
    url: "/projects/:projectId/apps/:appName/builds",
    schema: {
      params: ProjectAppParamsSchema,
      body: BuildAppSchema,
      response: {
        201: AppVersionSchema,
        400: ErrorSchema,
        404: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!ctx.core?.apps)
        return reply.status(503).send({ error: "Apps not configured" });
      try {
        const version = await ctx.core.apps.build({
          identity: resolveIdentity(request),
          projectId: request.params.projectId,
          appName: request.params.appName,
          kind: request.body.kind,
          commitSha: request.body.commitSha,
        });
        return reply.status(201).send(version);
      } catch (err) {
        if (err instanceof AppNotFoundError)
          return reply.status(404).send({ error: err.message });
        if (
          err instanceof AppPublishStateError ||
          err instanceof AppBuildFailedError ||
          err instanceof AppBundleTooLargeError
        )
          return reply.status(400).send({ error: err.message });
        throw err;
      }
    },
  });

  typed.route({
    method: "POST",
    url: "/projects/:projectId/app-versions/:versionId/publish",
    schema: {
      params: ProjectAppVersionParamsSchema,
      response: {
        200: AppVersionSchema,
        400: ErrorSchema,
        404: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!ctx.core?.apps)
        return reply.status(503).send({ error: "Apps not configured" });
      try {
        const version = await ctx.core.apps.publish({
          identity: resolveIdentity(request),
          projectId: request.params.projectId,
          versionId: request.params.versionId,
        });
        return reply.send(version);
      } catch (err) {
        if (err instanceof AppVersionNotFoundError)
          return reply.status(404).send({ error: err.message });
        if (err instanceof AppPublishStateError)
          return reply.status(400).send({ error: err.message });
        throw err;
      }
    },
  });

  typed.route({
    method: "GET",
    url: "/projects/:projectId/apps/:appName/view-state",
    schema: {
      params: ProjectAppParamsSchema,
      response: { 200: AppViewStateSchema, 503: ErrorSchema },
    },
    handler: async (request, reply) => {
      if (!ctx.core?.apps)
        return reply.status(503).send({ error: "Apps not configured" });
      const state = await ctx.core.apps.viewState({
        identity: resolveIdentity(request),
        projectId: request.params.projectId,
        appName: request.params.appName,
      });
      return reply.send(state);
    },
  });

  typed.route({
    method: "GET",
    url: "/projects/:projectId/app-versions/:versionId/bundle",
    schema: {
      params: ProjectAppVersionParamsSchema,
      response: {
        200: z.object({ code: z.string(), css: z.string() }),
        404: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!ctx.core?.apps)
        return reply.status(503).send({ error: "Apps not configured" });
      try {
        const bundle = await ctx.core.apps.getBundle({
          identity: resolveIdentity(request),
          projectId: request.params.projectId,
          versionId: request.params.versionId,
        });
        return reply.send(bundle);
      } catch (err) {
        if (err instanceof AppVersionNotFoundError)
          return reply.status(404).send({ error: err.message });
        throw err;
      }
    },
  });
}
