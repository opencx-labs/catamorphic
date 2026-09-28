import {
  AccessDeniedError,
  PersonalEnvironmentInvalidError,
  PersonalEnvironmentUnavailableError,
  ProjectNotFoundError,
} from "@catamorphic/core";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { RouteContext } from "../app.js";
import { resolveIdentity } from "../http-identity.js";
import {
  ErrorSchema,
  PersonalEnvironmentInvalidSchema,
  PersonalEnvironmentSchema,
  ProjectIdParamsSchema,
  PutPersonalEnvironmentSchema,
} from "../schemas.js";

/**
 * The caller's own personal environment for a project (ADR 0184): their
 * harness logins and listed files, which reach only their own chats'
 * sandboxes in Environments that allow personal credentials. Every route
 * acts on the caller's own set; none returns a value.
 */
export function registerPersonalEnvironmentRoutes(
  app: FastifyInstance,
  ctx: RouteContext,
): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const refuse = (reply: FastifyReply, error: unknown) => {
    if (error instanceof ProjectNotFoundError)
      return reply.status(404).send({ error: "Project not found" });
    if (error instanceof AccessDeniedError)
      return reply.status(403).send({ error: error.message });
    if (error instanceof PersonalEnvironmentUnavailableError)
      return reply.status(503).send({ error: error.message });
    throw error;
  };
  // Logins and 50 files of up to 256 KiB each, as base64.
  const bodyLimit = 24 * 1024 * 1024;

  typed.route({
    method: "PUT",
    url: "/projects/:projectId/personal-environment",
    bodyLimit,
    schema: {
      params: ProjectIdParamsSchema,
      body: PutPersonalEnvironmentSchema,
      response: {
        200: PersonalEnvironmentSchema,
        403: ErrorSchema,
        404: ErrorSchema,
        422: PersonalEnvironmentInvalidSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      const service = ctx.core?.personalEnvironments;
      if (!service)
        return reply
          .status(503)
          .send({ error: "Personal environments are not configured" });
      try {
        const status = await service.replace({
          identity: resolveIdentity(request),
          projectId: request.params.projectId,
          input: request.body,
        });
        return reply.send(status);
      } catch (error) {
        if (error instanceof PersonalEnvironmentInvalidError)
          return reply.status(422).send({
            error: error.message,
            code: "personal_environment_invalid",
            issues: [...error.issues],
          });
        return refuse(reply, error);
      }
    },
  });

  typed.route({
    method: "GET",
    url: "/projects/:projectId/personal-environment",
    schema: {
      params: ProjectIdParamsSchema,
      response: {
        200: PersonalEnvironmentSchema,
        403: ErrorSchema,
        404: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      const service = ctx.core?.personalEnvironments;
      if (!service)
        return reply
          .status(503)
          .send({ error: "Personal environments are not configured" });
      try {
        return reply.send(
          await service.status({
            identity: resolveIdentity(request),
            projectId: request.params.projectId,
          }),
        );
      } catch (error) {
        return refuse(reply, error);
      }
    },
  });

  typed.route({
    method: "DELETE",
    url: "/projects/:projectId/personal-environment",
    schema: {
      params: ProjectIdParamsSchema,
      response: {
        204: z.null(),
        403: ErrorSchema,
        404: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      const service = ctx.core?.personalEnvironments;
      if (!service)
        return reply
          .status(503)
          .send({ error: "Personal environments are not configured" });
      try {
        await service.remove({
          identity: resolveIdentity(request),
          projectId: request.params.projectId,
        });
        return reply.status(204).send(null);
      } catch (error) {
        return refuse(reply, error);
      }
    },
  });
}
