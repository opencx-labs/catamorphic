import {
  AccessDeniedError,
  AuthenticationRequiredError,
  ConnectionPermissionDeniedError,
  ConnectionUnavailableError,
  WorkflowEnablementConflictError,
  WorkflowEnablementConsentRequiredError,
  WorkflowEnablementNotFoundError,
  WorkflowEnablementSuspendedError,
} from "@catamorphic/core";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { RouteContext } from "../app.js";
import { resolveIdentity } from "../http-identity.js";
import {
  AuthenticationRequiredSchema,
  ErrorSchema,
  ProjectIdParamsSchema,
  WorkflowEnablementOwnerSchema,
  WorkflowEnablementPreviewSchema,
  WorkflowEnablementSchema,
} from "../schemas.js";

const EnablementParamsSchema = ProjectIdParamsSchema.extend({
  enablementId: z.string().uuid(),
});
const SelectionSchema = z.record(z.string(), z.string().uuid()).optional();
const PreviewBodySchema = z.object({
  workflowName: z.string().min(1),
  environment: z.string().min(1).optional(),
  owner: WorkflowEnablementOwnerSchema.optional(),
  connectionSelections: SelectionSchema,
});

export function registerWorkflowEnablementRoutes(
  app: FastifyInstance,
  ctx: RouteContext,
): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const service = () => ctx.core?.workflowEnablements;

  typed.route({
    method: "GET",
    url: "/projects/:projectId/workflow-enablements",
    schema: {
      params: ProjectIdParamsSchema,
      querystring: z.object({ workflowName: z.string().optional() }),
      response: { 200: z.array(WorkflowEnablementSchema), 503: ErrorSchema },
    },
    handler: async (request, reply) => {
      const workflowEnablements = service();
      if (!workflowEnablements) {
        return reply
          .status(503)
          .send({ error: "Workflow enablements unavailable" });
      }
      return reply.send(
        await workflowEnablements.list({
          identity: resolveIdentity(request),
          projectId: request.params.projectId,
          workflowName: request.query.workflowName,
        }),
      );
    },
  });

  typed.route({
    method: "POST",
    url: "/projects/:projectId/workflow-enablement-preview",
    schema: {
      params: ProjectIdParamsSchema,
      body: PreviewBodySchema,
      response: {
        200: WorkflowEnablementPreviewSchema,
        403: ErrorSchema,
        409: ErrorSchema,
        428: AuthenticationRequiredSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      const workflowEnablements = service();
      if (!workflowEnablements) {
        return reply
          .status(503)
          .send({ error: "Workflow enablements unavailable" });
      }
      try {
        return reply.send(
          await workflowEnablements.preview({
            identity: resolveIdentity(request),
            projectId: request.params.projectId,
            ...request.body,
          }),
        );
      } catch (error) {
        return handleEnablementError(error, reply);
      }
    },
  });

  typed.route({
    method: "POST",
    url: "/projects/:projectId/workflow-enablements",
    schema: {
      params: ProjectIdParamsSchema,
      body: PreviewBodySchema.extend({ consentDigest: z.string().length(64) }),
      response: {
        201: WorkflowEnablementSchema,
        403: ErrorSchema,
        409: ErrorSchema,
        428: AuthenticationRequiredSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      const workflowEnablements = service();
      if (!workflowEnablements) {
        return reply
          .status(503)
          .send({ error: "Workflow enablements unavailable" });
      }
      try {
        return reply.status(201).send(
          await workflowEnablements.create({
            identity: resolveIdentity(request),
            projectId: request.params.projectId,
            ...request.body,
          }),
        );
      } catch (error) {
        return handleEnablementError(error, reply);
      }
    },
  });

  typed.route({
    method: "GET",
    url: "/projects/:projectId/workflow-enablements/:enablementId",
    schema: {
      params: EnablementParamsSchema,
      response: {
        200: WorkflowEnablementSchema,
        403: ErrorSchema,
        404: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      const workflowEnablements = service();
      if (!workflowEnablements) {
        return reply
          .status(404)
          .send({ error: "Workflow enablement not found" });
      }
      try {
        const result = await workflowEnablements.get({
          identity: resolveIdentity(request),
          enablementId: request.params.enablementId,
        });
        return result.projectId === request.params.projectId
          ? reply.send(result)
          : reply.status(404).send({ error: "Workflow enablement not found" });
      } catch (error) {
        return handleEnablementError(error, reply);
      }
    },
  });

  for (const action of ["disable", "reenable"] as const) {
    typed.route({
      method: "POST",
      url: `/projects/:projectId/workflow-enablements/:enablementId/${action}`,
      schema: {
        params: EnablementParamsSchema,
        response: {
          200: WorkflowEnablementSchema,
          403: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
        },
      },
      handler: async (request, reply) => {
        const workflowEnablements = service();
        if (!workflowEnablements) {
          return reply
            .status(404)
            .send({ error: "Workflow enablement not found" });
        }
        try {
          const identity = resolveIdentity(request);
          const current = await workflowEnablements.get({
            identity,
            enablementId: request.params.enablementId,
          });
          if (current.projectId !== request.params.projectId) {
            return reply
              .status(404)
              .send({ error: "Workflow enablement not found" });
          }
          const result = await workflowEnablements[action]({
            identity,
            enablementId: request.params.enablementId,
          });
          return reply.send(result);
        } catch (error) {
          return handleEnablementError(error, reply);
        }
      },
    });
  }

  typed.route({
    method: "POST",
    url: "/projects/:projectId/workflow-enablements/:enablementId/update-deployment",
    schema: {
      params: EnablementParamsSchema,
      body: z.object({ consentDigest: z.string().length(64) }),
      response: {
        200: WorkflowEnablementSchema,
        403: ErrorSchema,
        404: ErrorSchema,
        409: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      const workflowEnablements = service();
      if (!workflowEnablements) {
        return reply
          .status(404)
          .send({ error: "Workflow enablement not found" });
      }
      try {
        const identity = resolveIdentity(request);
        const current = await workflowEnablements.get({
          identity,
          enablementId: request.params.enablementId,
        });
        if (current.projectId !== request.params.projectId) {
          return reply
            .status(404)
            .send({ error: "Workflow enablement not found" });
        }
        const result = await workflowEnablements.updateDeployment({
          identity,
          enablementId: request.params.enablementId,
          consentDigest: request.body.consentDigest,
        });
        return reply.send(result);
      } catch (error) {
        return handleEnablementError(error, reply);
      }
    },
  });
}

function handleEnablementError(error: unknown, reply: FastifyReply) {
  if (error instanceof AuthenticationRequiredError) {
    return reply.status(428).send({
      error: error.message,
      code: "authentication_required",
      environment: error.environment,
      requirements: error.requirements,
    });
  }
  if (error instanceof WorkflowEnablementNotFoundError) {
    return reply.status(404).send({ error: error.message });
  }
  if (
    error instanceof AccessDeniedError ||
    error instanceof ConnectionPermissionDeniedError
  ) {
    return reply.status(403).send({ error: error.message });
  }
  if (
    error instanceof WorkflowEnablementConsentRequiredError ||
    error instanceof WorkflowEnablementConflictError ||
    error instanceof ConnectionUnavailableError ||
    error instanceof WorkflowEnablementSuspendedError
  ) {
    return reply.status(409).send({ error: error.message });
  }
  throw error;
}
