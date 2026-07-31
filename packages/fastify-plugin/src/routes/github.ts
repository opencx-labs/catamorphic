import {
  GithubNotConnectedError,
  GithubTokenExpiredError,
  ProjectNotLinkedToGithubError,
} from "@catamorphic/core";
import { GithubApiError, GithubAuthError } from "@catamorphic/github";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { RouteContext } from "../app.js";
import { resolveIdentity } from "../http-identity.js";
import {
  ErrorSchema,
  GithubConnectSchema,
  GithubImportSchema,
  GithubRepoSchema,
  GithubStatusSchema,
  ProjectIdParamsSchema,
  ProjectSchema,
} from "../schemas.js";

/**
 * GitHub connection surface. OAuth here is the *web flow*: the host renders
 * GitHub's authorize page (`buildAuthorizeUrl` from `@catamorphic/github`),
 * GitHub redirects back to the host with a `code`, and the host posts that
 * code to `/github/connect`. Device-flow hosts (desktop) never use these
 * routes — they talk to the core service library-direct.
 */
export function registerGithubRoutes(app: FastifyInstance, ctx: RouteContext) {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  const unavailable = { error: "GitHub integration not configured" };

  typed.route({
    method: "GET",
    url: "/github/status",
    schema: {
      response: { 200: GithubStatusSchema, 503: ErrorSchema },
    },
    handler: async (request, reply) => {
      if (!ctx.core?.github) return reply.status(503).send(unavailable);
      const status = await ctx.core.github.status(resolveIdentity(request));
      return reply.send(
        status.connected
          ? { connected: true, login: status.login }
          : { connected: false },
      );
    },
  });

  typed.route({
    method: "POST",
    url: "/github/connect",
    schema: {
      body: GithubConnectSchema,
      response: {
        200: GithubStatusSchema,
        400: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!ctx.core?.github) return reply.status(503).send(unavailable);
      try {
        const status = await ctx.core.github.connectWithCode(
          resolveIdentity(request),
          request.body,
        );
        return reply.send(
          status.connected
            ? { connected: true, login: status.login }
            : { connected: false },
        );
      } catch (err) {
        if (err instanceof GithubAuthError) {
          return reply.status(400).send({ error: err.message });
        }
        throw err;
      }
    },
  });

  typed.route({
    method: "DELETE",
    url: "/github/connection",
    schema: {
      response: { 204: z.null(), 503: ErrorSchema },
    },
    handler: async (request, reply) => {
      if (!ctx.core?.github) return reply.status(503).send(unavailable);
      await ctx.core.github.disconnect(resolveIdentity(request));
      return reply.status(204).send(null);
    },
  });

  typed.route({
    method: "GET",
    url: "/github/repos",
    schema: {
      response: {
        200: z.array(GithubRepoSchema),
        401: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!ctx.core?.github) return reply.status(503).send(unavailable);
      try {
        const repos = await ctx.core.github.listRepos(resolveIdentity(request));
        return reply.send(repos);
      } catch (err) {
        const mapped = mapGithubError(err);
        return reply.status(mapped.status === 404 ? 401 : mapped.status).send({
          error: mapped.error,
        });
      }
    },
  });

  typed.route({
    method: "POST",
    url: "/github/import",
    schema: {
      body: GithubImportSchema,
      response: {
        201: ProjectSchema,
        401: ErrorSchema,
        404: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!ctx.core?.github) return reply.status(503).send(unavailable);
      try {
        const project = await ctx.core.github.importRepo(
          resolveIdentity(request),
          request.body,
        );
        return reply.status(201).send({
          id: project.id,
          name: project.name,
          storageType: project.storageType,
          remoteUrl: project.remoteUrl,
          defaultBranch: project.defaultBranch,
          createdAt: project.createdAt,
          updatedAt: project.updatedAt,
        });
      } catch (err) {
        const mapped = mapGithubError(err);
        return reply
          .status(mapped.status === 404 ? 404 : 401)
          .send({ error: mapped.error });
      }
    },
  });

  typed.route({
    method: "POST",
    url: "/projects/:projectId/github/push",
    schema: {
      params: ProjectIdParamsSchema,
      response: {
        204: z.null(),
        400: ErrorSchema,
        401: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!ctx.core?.github) return reply.status(503).send(unavailable);
      try {
        await ctx.core.github.pushProject(
          resolveIdentity(request),
          request.params.projectId,
        );
        return reply.status(204).send(null);
      } catch (err) {
        if (err instanceof ProjectNotLinkedToGithubError) {
          return reply.status(400).send({ error: err.message });
        }
        const mapped = mapGithubError(err);
        return reply
          .status(mapped.status === 404 ? 401 : mapped.status)
          .send({ error: mapped.error });
      }
    },
  });
}

/** Rethrows anything that is not a known GitHub failure. */
function mapGithubError(err: unknown): { status: 401 | 404; error: string } {
  if (
    err instanceof GithubNotConnectedError ||
    err instanceof GithubTokenExpiredError
  ) {
    return { status: 401, error: err.message };
  }
  if (err instanceof GithubApiError) {
    return { status: err.status === 404 ? 404 : 401, error: err.message };
  }
  throw err;
}
