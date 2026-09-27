import {
  AccessDeniedError,
  CodeHostNotConnectedError,
  CodeHostUnsupportedError,
  ConnectionPermissionDeniedError,
  ConnectionUnavailableError,
  ProjectAlreadyLinkedError,
  ProjectNotFoundError,
} from "@catamorphic/core";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { RouteContext } from "../app.js";
import { resolveIdentity } from "../http-identity.js";
import {
  AuthorizationChallengeSchema,
  CodeHostImportSchema,
  CodeHostParamsSchema,
  CodeHostPublishResultSchema,
  CodeHostPublishSchema,
  CodeHostRepositorySchema,
  ConnectionRecordSchema,
  ErrorSchema,
  ProjectIdParamsSchema,
  ProjectSchema,
} from "../schemas.js";

/**
 * Code hosts over connections (ADR 0177): the caller's personal connection
 * to a code host's provider, the repositories it reaches, repository import,
 * and publishing a project. A personal authorization completes through
 * `/connection-authorizations/complete` (or the provider's callback) and is
 * revoked with `DELETE /connections/:id`, like any connection.
 */
export function registerCodeHostRoutes(
  app: FastifyInstance,
  ctx: RouteContext,
): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const unavailable = { error: "No code host is configured" };

  typed.route({
    method: "GET",
    url: "/code-hosts",
    schema: {
      response: {
        200: z.array(
          z.object({
            provider: z.string(),
            displayName: z.string(),
            /** The caller's personal connection, when there is one. */
            connection: ConnectionRecordSchema.nullable(),
          }),
        ),
      },
    },
    handler: async (request, reply) => {
      const codeHosts = ctx.core?.codeHosts;
      if (!codeHosts?.available) return reply.send([]);
      const identity = resolveIdentity(request);
      return reply.send(
        await Promise.all(
          codeHosts.list().map(async (host) => ({
            ...host,
            connection:
              (await codeHosts.personalConnection({
                identity,
                provider: host.provider,
              })) ?? null,
          })),
        ),
      );
    },
  });

  typed.route({
    method: "POST",
    url: "/code-hosts/:provider/connection/authorize",
    schema: {
      params: CodeHostParamsSchema,
      body: z.object({ redirectUri: z.string().url() }),
      response: {
        200: z.object({
          authorizationId: z.string().min(1),
          challenge: AuthorizationChallengeSchema,
        }),
        404: ErrorSchema,
        409: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      const connections = ctx.core?.connections;
      if (!connections || !ctx.core?.codeHosts.available)
        return reply.status(503).send(unavailable);
      if (
        !ctx.core.codeHosts
          .list()
          .some((host) => host.provider === request.params.provider)
      )
        return reply.status(404).send({ error: "Unknown code host" });
      try {
        return reply.send(
          await connections.beginPersonalAuthorization({
            identity: resolveIdentity(request),
            providerKind: request.params.provider,
            redirectUri: request.body.redirectUri,
          }),
        );
      } catch (error) {
        return codeHostError(error, reply);
      }
    },
  });

  typed.route({
    method: "GET",
    url: "/code-hosts/:provider/repositories",
    schema: {
      params: CodeHostParamsSchema,
      response: {
        200: z.array(CodeHostRepositorySchema),
        401: ErrorSchema,
        404: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      const codeHosts = ctx.core?.codeHosts;
      if (!codeHosts?.available) return reply.status(503).send(unavailable);
      try {
        return reply.send(
          await codeHosts.listRepositories({
            identity: resolveIdentity(request),
            provider: request.params.provider,
          }),
        );
      } catch (error) {
        return codeHostError(error, reply);
      }
    },
  });

  typed.route({
    method: "POST",
    url: "/code-hosts/:provider/import",
    schema: {
      params: CodeHostParamsSchema,
      body: CodeHostImportSchema,
      response: {
        201: ProjectSchema,
        401: ErrorSchema,
        403: ErrorSchema,
        404: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      const codeHosts = ctx.core?.codeHosts;
      if (!codeHosts?.available) return reply.status(503).send(unavailable);
      try {
        const project = await codeHosts.importRepository({
          identity: resolveIdentity(request),
          provider: request.params.provider,
          fullName: request.body.fullName,
          ...(request.body.name ? { name: request.body.name } : {}),
        });
        return reply.status(201).send({
          id: project.id,
          name: project.name,
          storageType: project.storageType,
          remoteUrl: project.remoteUrl,
          remoteOwnership: project.remoteOwnership,
          defaultBranch: project.defaultBranch,
          createdAt: project.createdAt,
          updatedAt: project.updatedAt,
        });
      } catch (error) {
        return codeHostError(error, reply);
      }
    },
  });

  typed.route({
    method: "POST",
    url: "/projects/:projectId/code-host/publish",
    schema: {
      params: ProjectIdParamsSchema,
      body: CodeHostPublishSchema,
      response: {
        201: CodeHostPublishResultSchema,
        401: ErrorSchema,
        403: ErrorSchema,
        404: ErrorSchema,
        409: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      const codeHosts = ctx.core?.codeHosts;
      if (!codeHosts?.available) return reply.status(503).send(unavailable);
      try {
        return reply.status(201).send(
          await codeHosts.publishProject({
            identity: resolveIdentity(request),
            projectId: request.params.projectId,
            ...request.body,
          }),
        );
      } catch (error) {
        return codeHostError(error, reply);
      }
    },
  });
}

/** Known code-host failures as HTTP answers; anything else is rethrown. */
function codeHostError(error: unknown, reply: FastifyReply): FastifyReply {
  if (error instanceof CodeHostNotConnectedError)
    return reply.status(401).send({ error: error.message });
  if (
    error instanceof AccessDeniedError ||
    error instanceof ConnectionPermissionDeniedError
  )
    return reply.status(403).send({ error: error.message });
  if (
    error instanceof CodeHostUnsupportedError ||
    error instanceof ProjectNotFoundError
  )
    return reply.status(404).send({ error: error.message });
  if (
    error instanceof ProjectAlreadyLinkedError ||
    error instanceof ConnectionUnavailableError
  )
    return reply.status(409).send({ error: error.message });
  if (error instanceof Error && "status" in error) {
    // A code host's own API refusal (e.g. GitHub 404 for a repository).
    const status = error.status === 404 ? 404 : 401;
    return reply.status(status).send({ error: error.message });
  }
  throw error;
}
