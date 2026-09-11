import { APP_ICON_NAMES } from "@catamorphic/app";
import { SessionArtifactNotFoundError } from "@catamorphic/core";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { RouteContext } from "../app.js";
import { resolveIdentity } from "../http-identity.js";
import {
  AppVersionSchema,
  ErrorSchema,
  RunSchema,
  TriggerRunSchema,
} from "../schemas.js";

export const SessionArtifactSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  sessionId: z.string().uuid().nullable(),
  kind: z.enum(["app", "workflow"]),
  name: z.string(),
  title: z.string(),
  sourcePath: z.string(),
  remoteBranch: z.string(),
  commitSha: z.string(),
  revision: z.number().int(),
  status: z.enum(["active", "discarded"]),
  appName: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
const SessionParams = z.object({
  projectId: z.string().uuid(),
  sessionId: z.string().uuid(),
});
const ArtifactParams = z.object({
  projectId: z.string().uuid(),
  artifactId: z.string().uuid(),
});
const Files = z
  .record(z.string().min(1).max(512), z.string())
  .refine((files) => Object.keys(files).length <= 256);
const Outcome = z.object({
  artifact: SessionArtifactSchema,
  build: AppVersionSchema.nullable(),
});

export function registerSessionArtifactRoutes(
  app: FastifyInstance,
  ctx: RouteContext,
) {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.route({
    method: "GET",
    url: "/projects/:projectId/agent/sessions/:sessionId/artifacts",
    schema: {
      params: SessionParams,
      response: {
        200: z.array(SessionArtifactSchema),
        400: ErrorSchema,
        403: ErrorSchema,
        404: ErrorSchema,
        409: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!ctx.core)
        return reply.status(503).send({ error: "Artifacts are unavailable" });
      return ctx.core.sessionArtifacts.list({
        ...request.params,
        identity: resolveIdentity(request),
      });
    },
  });
  typed.route({
    method: "POST",
    url: "/projects/:projectId/agent/sessions/:sessionId/artifacts",
    bodyLimit: 6 * 1024 * 1024,
    schema: {
      params: SessionParams,
      body: z.object({
        kind: z.enum(["app", "workflow"]),
        name: z.string().min(1).max(100),
        title: z.string().max(200).optional(),
        icon: z.enum(APP_ICON_NAMES).optional(),
        source: z.string().max(5 * 1024 * 1024),
        files: Files.optional(),
      }),
      response: {
        201: Outcome,
        400: ErrorSchema,
        403: ErrorSchema,
        404: ErrorSchema,
        409: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!ctx.core || (request.body.kind === "app" && !ctx.core.apps))
        return reply.status(503).send({ error: "Artifacts are unavailable" });
      const identity = resolveIdentity(request);
      const artifact = await ctx.core.sessionArtifacts.create({
        ...request.params,
        ...request.body,
        identity,
      });
      const build =
        artifact.appName && ctx.core.apps
          ? await ctx.core.apps.build({
              identity,
              projectId: artifact.projectId,
              appName: artifact.appName,
              artifactId: artifact.id,
              kind: "preview",
            })
          : null;
      if (artifact.appName && request.body.icon && ctx.core.apps)
        await ctx.core.apps.updatePresentation({
          identity,
          projectId: artifact.projectId,
          appName: artifact.appName,
          icon: request.body.icon,
        });
      return reply.status(201).send({ artifact, build });
    },
  });
  typed.route({
    method: "GET",
    url: "/projects/:projectId/session-artifacts/:artifactId",
    schema: {
      params: ArtifactParams,
      response: {
        200: SessionArtifactSchema,
        400: ErrorSchema,
        403: ErrorSchema,
        404: ErrorSchema,
        409: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!ctx.core)
        return reply.status(503).send({ error: "Artifacts are unavailable" });
      try {
        return await ctx.core.sessionArtifacts.get({
          ...request.params,
          identity: resolveIdentity(request),
        });
      } catch (error) {
        if (error instanceof SessionArtifactNotFoundError)
          return reply.status(404).send({ error: error.message });
        throw error;
      }
    },
  });
  typed.route({
    method: "GET",
    url: "/projects/:projectId/session-artifacts/:artifactId/files",
    schema: {
      params: ArtifactParams,
      response: {
        200: z.record(z.string(), z.string()),
        400: ErrorSchema,
        403: ErrorSchema,
        404: ErrorSchema,
        409: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!ctx.core)
        return reply.status(503).send({ error: "Artifacts are unavailable" });
      return ctx.core.sessionArtifacts.files({
        ...request.params,
        identity: resolveIdentity(request),
      });
    },
  });
  typed.route({
    method: "PATCH",
    url: "/projects/:projectId/session-artifacts/:artifactId",
    bodyLimit: 6 * 1024 * 1024,
    schema: {
      params: ArtifactParams,
      body: z.object({
        revision: z.number().int().positive(),
        title: z.string().max(200).optional(),
        files: z.record(z.string().min(1).max(512), z.string().nullable()),
      }),
      response: {
        200: Outcome,
        400: ErrorSchema,
        403: ErrorSchema,
        404: ErrorSchema,
        409: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!ctx.core)
        return reply.status(503).send({ error: "Artifacts are unavailable" });
      const identity = resolveIdentity(request);
      const artifact = await ctx.core.sessionArtifacts.update({
        ...request.params,
        ...request.body,
        identity,
      });
      const build =
        artifact.appName && ctx.core.apps
          ? await ctx.core.apps.build({
              identity,
              projectId: artifact.projectId,
              appName: artifact.appName,
              artifactId: artifact.id,
              kind: "preview",
            })
          : null;
      return { artifact, build };
    },
  });
  typed.route({
    method: "DELETE",
    url: "/projects/:projectId/session-artifacts/:artifactId",
    schema: {
      params: ArtifactParams,
      response: {
        204: z.null(),
        400: ErrorSchema,
        403: ErrorSchema,
        404: ErrorSchema,
        409: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!ctx.core)
        return reply.status(503).send({ error: "Artifacts are unavailable" });
      const identity = resolveIdentity(request);
      const artifact = await ctx.core.sessionArtifacts.discard({
        ...request.params,
        identity,
      });
      if (artifact.sessionId && ctx.core.watchers)
        await ctx.core.watchers.stop({
          identity,
          projectId: artifact.projectId,
          sessionId: artifact.sessionId,
          watcherId: artifact.id,
        });
      return reply.status(204).send(null);
    },
  });
  typed.route({
    method: "POST",
    url: "/projects/:projectId/session-artifacts/:artifactId/runs",
    schema: {
      params: ArtifactParams,
      body: TriggerRunSchema.extend({ environment: z.string().optional() }),
      response: {
        201: RunSchema,
        400: ErrorSchema,
        403: ErrorSchema,
        404: ErrorSchema,
        409: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!ctx.core)
        return reply.status(503).send({ error: "Artifacts are unavailable" });
      const identity = resolveIdentity(request);
      const artifact = await ctx.core.sessionArtifacts.get({
        ...request.params,
        identity,
      });
      if (artifact.kind !== "workflow")
        return reply.status(400).send({ error: "This artifact is an app" });
      await ctx.core.sessionArtifacts.assertActive({
        ...request.params,
        identity,
      });
      const run = await ctx.core.runs.triggerAtCommit({
        ...request.body,
        identity,
        projectId: artifact.projectId,
        workflowName: artifact.name,
        commitSha: artifact.commitSha,
        remoteBranch: artifact.remoteBranch,
      });
      return reply.status(201).send(run);
    },
  });
}
