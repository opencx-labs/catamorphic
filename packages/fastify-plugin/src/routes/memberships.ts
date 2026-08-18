import { ProjectNotFoundError } from "@catamorphic/core";

class ServiceNotConfiguredError extends Error {
  readonly statusCode = 503;
  constructor() {
    super("Service not configured");
  }
}

import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { RouteContext } from "../app.js";
import { resolveIdentity } from "../http-identity.js";
import {
  ErrorSchema,
  GrantMembershipSchema,
  MembershipParamsSchema,
  MembershipSchema,
  ProjectIdParamsSchema,
  ProjectRoleEntrySchema,
} from "../schemas.js";

/**
 * Roles and memberships (ADR 0055). Roles are committed files
 * (`roles/<slug>.json`) — read here, edited through the project file
 * routes like any other file. Memberships are the stock `user → roles +
 * grants` table: what a host's invite writes and its identity resolver
 * reads (`core.memberships.identityFor`). All builder-only, except a
 * member reading their own row.
 */
export function registerMembershipRoutes(
  app: FastifyInstance,
  ctx: RouteContext,
) {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const core = () => {
    if (!ctx.core) throw new ServiceNotConfiguredError();
    return ctx.core;
  };

  typed.route({
    method: "GET",
    url: "/projects/:projectId/roles",
    schema: {
      params: ProjectIdParamsSchema,
      response: { 200: ProjectRoleEntrySchema.array(), 404: ErrorSchema },
    },
    handler: async (request, reply) => {
      const identity = resolveIdentity(request);
      try {
        return reply.send(
          await core().roles.list(identity, request.params.projectId),
        );
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
    url: "/projects/:projectId/memberships",
    schema: {
      params: ProjectIdParamsSchema,
      response: { 200: MembershipSchema.array(), 404: ErrorSchema },
    },
    handler: async (request, reply) => {
      const identity = resolveIdentity(request);
      try {
        return reply.send(
          await core().memberships.list({
            identity,
            projectId: request.params.projectId,
          }),
        );
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
    url: "/projects/:projectId/memberships/:externalUserId",
    schema: {
      params: MembershipParamsSchema,
      response: { 200: MembershipSchema, 404: ErrorSchema },
    },
    handler: async (request, reply) => {
      const identity = resolveIdentity(request);
      try {
        const membership = await core().memberships.get({
          identity,
          projectId: request.params.projectId,
          externalUserId: request.params.externalUserId,
        });
        if (!membership) {
          return reply.status(404).send({ error: "Membership not found" });
        }
        return reply.send(membership);
      } catch (err) {
        if (err instanceof ProjectNotFoundError) {
          return reply.status(404).send({ error: "Project not found" });
        }
        throw err;
      }
    },
  });

  typed.route({
    method: "PUT",
    url: "/projects/:projectId/memberships/:externalUserId",
    schema: {
      params: MembershipParamsSchema,
      body: GrantMembershipSchema,
      response: { 200: MembershipSchema, 404: ErrorSchema },
    },
    handler: async (request, reply) => {
      const identity = resolveIdentity(request);
      try {
        return reply.send(
          await core().memberships.grant({
            identity,
            projectId: request.params.projectId,
            externalUserId: request.params.externalUserId,
            roles: request.body.roles,
            ...(request.body.grants ? { grants: request.body.grants } : {}),
          }),
        );
      } catch (err) {
        if (err instanceof ProjectNotFoundError) {
          return reply.status(404).send({ error: "Project not found" });
        }
        throw err;
      }
    },
  });

  typed.route({
    method: "DELETE",
    url: "/projects/:projectId/memberships/:externalUserId",
    schema: {
      params: MembershipParamsSchema,
      response: { 204: z.null(), 404: ErrorSchema },
    },
    handler: async (request, reply) => {
      const identity = resolveIdentity(request);
      try {
        const removed = await core().memberships.revoke({
          identity,
          projectId: request.params.projectId,
          externalUserId: request.params.externalUserId,
        });
        if (!removed) {
          return reply.status(404).send({ error: "Membership not found" });
        }
        return reply.status(204).send(null);
      } catch (err) {
        if (err instanceof ProjectNotFoundError) {
          return reply.status(404).send({ error: "Project not found" });
        }
        throw err;
      }
    },
  });
}
