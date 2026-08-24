import {
  CONNECTION_ALIAS_PATTERN,
  ConnectionNotFoundError,
  ConnectionPermissionDeniedError,
  ConnectionUnavailableError,
} from "@catamorphic/core";
import type { FastifyInstance, FastifyReply } from "fastify";
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

  typed.route({
    method: "POST",
    url: "/projects/:projectId/connections",
    schema: {
      params: ProjectIdParamsSchema,
      body: z.object({
        providerKind: z.string().min(1),
        principalKind: z.enum(["project_service", "tenant_service"]),
        label: z.string().min(1),
        credential: z.string().min(1),
        capabilities: z.array(z.string()).optional(),
      }),
      response: {
        201: ConnectionRecordSchema,
        403: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      const connections = service();
      if (!connections)
        return reply.status(503).send({ error: "Connections not configured" });
      try {
        const record = await connections.create({
          identity: resolveIdentity(request),
          projectId: request.params.projectId,
          providerKind: request.body.providerKind,
          principalKind: request.body.principalKind,
          label: request.body.label,
          material: new TextEncoder().encode(request.body.credential),
          capabilities: request.body.capabilities,
        });
        return reply.status(201).send(record);
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
    method: "PUT",
    url: "/connections/:connectionId/credential",
    schema: {
      params: z.object({ connectionId: z.string().uuid() }),
      body: z.object({ credential: z.string().min(1) }),
      response: {
        200: ConnectionRecordSchema,
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
          await connections.rotateServiceCredential({
            identity: resolveIdentity(request),
            connectionId: request.params.connectionId,
            material: new TextEncoder().encode(request.body.credential),
          }),
        );
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
    method: "PUT",
    url: "/projects/:projectId/environments/:environment/connections/:alias",
    schema: {
      params: BindingParams,
      body: z.object({
        providerKind: z.string().min(1),
        principalKinds: z
          .array(z.enum(["member", "project_service", "tenant_service"]))
          .min(1),
        serviceConnectionId: z.string().uuid().optional(),
        capabilities: z.array(z.string()).optional(),
      }),
      response: {
        200: ConnectionBindingSchema,
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
          await connections.bind({
            identity: resolveIdentity(request),
            projectId: request.params.projectId,
            environment: request.params.environment,
            alias: request.params.alias,
            providerKind: request.body.providerKind,
            principalKinds: request.body.principalKinds,
            serviceConnectionId: request.body.serviceConnectionId,
            capabilities: request.body.capabilities,
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
  if (error instanceof ConnectionUnavailableError) {
    return reply.status(409).send({ error: error.message });
  }
  throw error;
}
