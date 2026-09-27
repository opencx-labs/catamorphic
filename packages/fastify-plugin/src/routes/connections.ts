import {
  CONNECTION_ALIAS_PATTERN,
  CONNECTION_NAME_PATTERN,
  ConnectionNameTakenError,
  ConnectionNotFoundError,
  ConnectionPermissionDeniedError,
  ConnectionUnavailableError,
} from "@catamorphic/core";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { RouteContext } from "../app.js";
import { resolveIdentity } from "../http-identity.js";
import {
  AuthorizationChallengeSchema,
  ConnectionBindingSchema,
  ConnectionRecordSchema,
  ErrorSchema,
  ProjectIdParamsSchema,
} from "../schemas.js";

const EnvironmentParams = ProjectIdParamsSchema.extend({
  environment: z.string().min(1),
});
const BindingParams = EnvironmentParams.extend({
  alias: z.string().regex(CONNECTION_ALIAS_PATTERN),
});
const AuditEventSchema = z.object({
  id: z.string(),
  projectId: z.string().uuid().nullable(),
  connectionId: z.string().uuid().nullable(),
  allocationId: z.string().uuid().nullable(),
  actorExternalUserId: z.string().nullable(),
  eventType: z.string(),
  outcome: z.string(),
  action: z.string().nullable(),
  argumentsDigest: z.string().nullable(),
  metadata: z.unknown(),
  createdAt: z.string().datetime(),
});

export function registerConnectionRoutes(
  app: FastifyInstance,
  ctx: RouteContext,
): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const service = () => ctx.core?.connections;
  const apiBase = (request: FastifyRequest) =>
    ctx.publicApiBase ??
    `${request.protocol}://${request.host}${app.prefix}`.replace(/\/$/, "");

  typed.route({
    method: "GET",
    url: "/connection-providers",
    schema: {
      response: {
        200: z.array(z.object({ kind: z.string(), displayName: z.string() })),
        503: ErrorSchema,
      },
    },
    handler: async (_request, reply) => {
      const connections = service();
      return connections
        ? reply.send(connections.providerCatalog())
        : reply.status(503).send({ error: "Connections not configured" });
    },
  });

  typed.route({
    method: "GET",
    url: "/projects/:projectId/connections",
    schema: {
      params: ProjectIdParamsSchema,
      response: { 200: z.array(ConnectionRecordSchema), 503: ErrorSchema },
    },
    handler: async (request, reply) => {
      const connections = service();
      if (!connections)
        return reply.status(503).send({ error: "Connections not configured" });
      return reply.send(
        await connections.list({
          identity: resolveIdentity(request),
          projectId: request.params.projectId,
        }),
      );
    },
  });

  // Named service connections (ADR 0172): created by a connection
  // administrator, authorized (and rotated) through the provider's own
  // challenge, and bound to Environments by name in `.work/project.json`.
  typed.route({
    method: "GET",
    url: "/service-connections",
    schema: {
      querystring: z.object({ projectId: z.string().uuid().optional() }),
      response: {
        200: z.array(ConnectionRecordSchema),
        403: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      const connections = service();
      if (!connections)
        return reply.status(503).send({ error: "Connections not configured" });
      try {
        return reply.send(
          await connections.listServices({
            identity: resolveIdentity(request),
            ...(request.query.projectId
              ? { projectId: request.query.projectId }
              : {}),
          }),
        );
      } catch (error) {
        return handleConnectionError(error, reply);
      }
    },
  });

  typed.route({
    method: "POST",
    url: "/service-connections",
    schema: {
      body: z.object({
        name: z.string().regex(CONNECTION_NAME_PATTERN),
        providerKind: z.string().min(1),
        principalKind: z.enum(["tenant_service", "project_service"]),
        /** Required for a `project_service` connection. */
        projectId: z.string().uuid().optional(),
        label: z.string().min(1).max(200).optional(),
      }),
      response: {
        201: ConnectionRecordSchema,
        400: ErrorSchema,
        403: ErrorSchema,
        409: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      const connections = service();
      if (!connections)
        return reply.status(503).send({ error: "Connections not configured" });
      if (
        request.body.principalKind === "project_service" &&
        !request.body.projectId
      ) {
        return reply
          .status(400)
          .send({ error: "A project service connection names its project" });
      }
      if (
        !connections
          .providerCatalog()
          .some((provider) => provider.kind === request.body.providerKind)
      ) {
        return reply.status(400).send({
          error: `Unknown connection provider '${request.body.providerKind}'`,
        });
      }
      try {
        const record = await connections.createService({
          identity: resolveIdentity(request),
          name: request.body.name,
          providerKind: request.body.providerKind,
          principalKind: request.body.principalKind,
          ...(request.body.projectId
            ? { projectId: request.body.projectId }
            : {}),
          ...(request.body.label ? { label: request.body.label } : {}),
        });
        return reply.status(201).send(record);
      } catch (error) {
        return handleConnectionError(error, reply);
      }
    },
  });

  typed.route({
    method: "POST",
    url: "/service-connections/:connectionId/authorize",
    schema: {
      params: z.object({ connectionId: z.string().uuid() }),
      response: {
        200: z.object({
          authorizationId: z.string().min(1),
          challenge: AuthorizationChallengeSchema,
        }),
        403: ErrorSchema,
        404: ErrorSchema,
        409: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      const connections = service();
      if (!connections)
        return reply.status(503).send({ error: "Connections not configured" });
      try {
        return reply.send(
          await connections.beginServiceAuthorization({
            identity: resolveIdentity(request),
            connectionId: request.params.connectionId,
            // A service authorization always returns to this server's own
            // callback, the redirect a pre-registered OAuth client lists.
            redirectUri: `${apiBase(request)}/connection-authorizations/callback`,
          }),
        );
      } catch (error) {
        return handleConnectionError(error, reply);
      }
    },
  });

  typed.route({
    method: "DELETE",
    url: "/projects/:projectId/environments/:environment/connections/:alias/attachment",
    schema: {
      params: BindingParams,
      response: {
        204: z.null(),
        403: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      const connections = service();
      if (!connections)
        return reply.status(503).send({ error: "Connections not configured" });
      try {
        await connections.detachMember({
          identity: resolveIdentity(request),
          projectId: request.params.projectId,
          environment: request.params.environment,
          alias: request.params.alias,
        });
        return reply.status(204).send(null);
      } catch (error) {
        return handleConnectionError(error, reply);
      }
    },
  });

  typed.route({
    method: "GET",
    url: "/projects/:projectId/connection-audit",
    schema: {
      params: ProjectIdParamsSchema,
      querystring: z.object({
        limit: z.coerce.number().int().min(1).max(500).optional(),
      }),
      response: {
        200: z.array(AuditEventSchema),
        403: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      const connections = service();
      if (!connections)
        return reply.status(503).send({ error: "Connections not configured" });
      try {
        return reply.send(
          await connections.listAudit({
            identity: resolveIdentity(request),
            projectId: request.params.projectId,
            limit: request.query.limit,
          }),
        );
      } catch (error) {
        return handleConnectionError(error, reply);
      }
    },
  });

  typed.route({
    method: "GET",
    url: "/projects/:projectId/environments/:environment/connections",
    schema: {
      params: EnvironmentParams,
      response: {
        200: z.array(ConnectionBindingSchema),
        403: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      const connections = service();
      if (!connections)
        return reply.status(503).send({ error: "Connections not configured" });
      try {
        return reply.send(
          await connections.listBindings({
            identity: resolveIdentity(request),
            projectId: request.params.projectId,
            environment: request.params.environment,
          }),
        );
      } catch (error) {
        return handleConnectionError(error, reply);
      }
    },
  });

  typed.route({
    method: "POST",
    url: "/projects/:projectId/environments/:environment/connections/:alias/authorize",
    schema: {
      params: BindingParams,
      body: z.object({ redirectUri: z.string().url() }),
      response: {
        200: z.object({
          authorizationId: z.string().min(1),
          challenge: AuthorizationChallengeSchema,
        }),
        403: ErrorSchema,
        409: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      const connections = service();
      if (!connections)
        return reply.status(503).send({ error: "Connections not configured" });
      try {
        return reply.send(
          await connections.beginAuthorization({
            identity: resolveIdentity(request),
            projectId: request.params.projectId,
            environment: request.params.environment,
            alias: request.params.alias,
            redirectUri: request.body.redirectUri,
          }),
        );
      } catch (error) {
        return handleConnectionError(error, reply);
      }
    },
  });

  typed.route({
    method: "POST",
    url: "/connection-authorizations/complete",
    schema: {
      body: z.object({
        state: z.string().min(1),
        callback: z.record(z.string(), z.string()),
      }),
      response: {
        200: ConnectionRecordSchema,
        403: ErrorSchema,
        409: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      const connections = service();
      if (!connections)
        return reply.status(503).send({ error: "Connections not configured" });
      try {
        return reply.send(
          await connections.completeAuthorization({
            identity: resolveIdentity(request),
            state: request.body.state,
            callback: request.body.callback,
          }),
        );
      } catch (error) {
        return handleConnectionError(error, reply);
      }
    },
  });

  typed.route({
    method: "POST",
    url: "/connection-authorizations/status",
    schema: {
      body: z.object({ state: z.string().min(1) }),
      response: {
        200: z.object({ status: z.string() }),
        409: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      const connections = service();
      if (!connections)
        return reply.status(503).send({ error: "Connections not configured" });
      try {
        return reply.send(
          await connections.authorizationStatus({
            identity: resolveIdentity(request),
            state: request.body.state,
          }),
        );
      } catch (error) {
        return handleConnectionError(error, reply);
      }
    },
  });

  typed.route({
    method: "GET",
    url: "/connection-authorizations/callback",
    config: { public: true },
    schema: {
      querystring: z.object({
        state: z.string().min(1),
        code: z.string().optional(),
        iss: z.string().optional(),
        error: z.string().optional(),
        error_description: z.string().optional(),
      }),
      response: {
        200: ConnectionRecordSchema,
        409: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      const connections = service();
      if (!connections)
        return reply.status(503).send({ error: "Connections not configured" });
      try {
        if (request.query.error) {
          throw new ConnectionUnavailableError(
            "authorization",
            "Authorization was declined",
          );
        }
        return reply.send(
          await connections.completeAuthorizationCallback({
            state: request.query.state,
            callback: {
              ...(request.query.code ? { code: request.query.code } : {}),
              ...(request.query.iss ? { iss: request.query.iss } : {}),
            },
          }),
        );
      } catch (error) {
        return handleConnectionError(error, reply);
      }
    },
  });

  typed.route({
    method: "DELETE",
    url: "/connections/:connectionId",
    schema: {
      params: z.object({ connectionId: z.string().uuid() }),
      response: {
        204: z.null(),
        403: ErrorSchema,
        404: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      const connections = service();
      if (!connections)
        return reply.status(503).send({ error: "Connections not configured" });
      try {
        await connections.revoke({
          identity: resolveIdentity(request),
          connectionId: request.params.connectionId,
        });
        return reply.status(204).send(null);
      } catch (error) {
        return handleConnectionError(error, reply);
      }
    },
  });
}

function handleConnectionError(
  error: unknown,
  reply: FastifyReply,
): FastifyReply {
  if (error instanceof ConnectionPermissionDeniedError) {
    return reply.status(403).send({ error: error.message });
  }
  if (error instanceof ConnectionNotFoundError) {
    return reply.status(404).send({ error: error.message });
  }
  if (error instanceof ConnectionNameTakenError) {
    return reply.status(409).send({ error: error.message });
  }
  if (error instanceof ConnectionUnavailableError) {
    return reply.status(409).send({ error: error.message });
  }
  throw error;
}
