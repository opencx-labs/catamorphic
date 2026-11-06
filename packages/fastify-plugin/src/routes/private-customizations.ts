import {
  DocumentConflictError,
  DocumentNotFoundError,
  DocumentPathError,
  PrivateStateDeleteSchema,
  PrivateStateReadSchema,
  PrivateStateSchema,
  PrivateStateWriteSchema,
  PublishNotificationSchema,
} from "@catamorphic/core";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { RouteContext } from "../app.js";
import { resolveIdentity } from "../http-identity.js";
import {
  AuthenticationRequiredSchema,
  ErrorSchema,
  JsonValueSchema,
  RunSchema,
  WorkflowEnablementPreviewSchema,
  WorkflowEnablementSchema,
} from "../schemas.js";
import { replyForTriggerError } from "./run-errors.js";
import { SessionArtifactSchema } from "./session-artifacts.js";
import { handleEnablementError } from "./workflow-enablements.js";

const State = PrivateStateSchema.extend({ value: JsonValueSchema });
const StateWrite = PrivateStateWriteSchema.extend({ value: JsonValueSchema });
const Project = z.object({ projectId: z.string().uuid() });
const Artifact = Project.extend({ artifactId: z.string().uuid() });
const Revision = z.object({
  revision: z.number().int().positive(),
  environment: z.string().optional(),
});
const errors = {
  400: ErrorSchema,
  403: ErrorSchema,
  404: ErrorSchema,
  409: ErrorSchema.extend({ currentVersion: z.number().optional() }),
  422: ErrorSchema,
  428: AuthenticationRequiredSchema,
  429: ErrorSchema,
  503: ErrorSchema,
};

export function registerPrivateCustomizationRoutes(
  app: FastifyInstance,
  ctx: RouteContext,
) {
  app.register(async (privateApp) => {
    privateApp.setErrorHandler((error, _request, reply) => {
      if (error instanceof DocumentConflictError)
        return reply
          .status(409)
          .send({ error: error.message, currentVersion: error.currentVersion });
      if (error instanceof DocumentNotFoundError)
        return reply.status(404).send({ error: error.message });
      if (error instanceof DocumentPathError)
        return reply.status(400).send({ error: error.message });
      const triggerError = replyForTriggerError(error, reply);
      if (triggerError) return triggerError;
      return handleEnablementError(error, reply);
    });
    const typed = privateApp.withTypeProvider<ZodTypeProvider>();
    typed.post(
      "/projects/:projectId/private-state/read",
      {
        schema: {
          params: Project,
          body: PrivateStateReadSchema,
          response: { 200: State, ...errors },
        },
      },
      async (request, reply) => {
        if (!ctx.core)
          return reply
            .status(503)
            .send({ error: "Private state is unavailable" });
        return ctx.core.privateState.read({
          ...request.params,
          ...request.body,
          identity: resolveIdentity(request),
        });
      },
    );
    typed.put(
      "/projects/:projectId/private-state",
      {
        schema: {
          params: Project,
          body: StateWrite,
          response: { 200: State, ...errors },
        },
      },
      async (request, reply) => {
        if (!ctx.core)
          return reply
            .status(503)
            .send({ error: "Private state is unavailable" });
        return ctx.core.privateState.write({
          ...request.params,
          ...request.body,
          identity: resolveIdentity(request),
        });
      },
    );
    typed.delete(
      "/projects/:projectId/private-state",
      {
        schema: {
          params: Project,
          body: PrivateStateDeleteSchema,
          response: { 200: z.object({ version: z.number().int() }), ...errors },
        },
      },
      async (request, reply) => {
        if (!ctx.core)
          return reply
            .status(503)
            .send({ error: "Private state is unavailable" });
        return ctx.core.privateState.delete({
          ...request.params,
          ...request.body,
          identity: resolveIdentity(request),
        });
      },
    );
    typed.post(
      "/projects/:projectId/notifications",
      {
        schema: {
          params: Project,
          body: PublishNotificationSchema,
          response: {
            200: z.object({ published: z.literal(true) }),
            ...errors,
          },
        },
      },
      async (request, reply) => {
        if (!ctx.core)
          return reply
            .status(503)
            .send({ error: "Notifications are unavailable" });
        return ctx.core.notifications.notify({
          ...request.params,
          ...request.body,
          identity: resolveIdentity(request),
        });
      },
    );
    typed.get(
      "/projects/:projectId/private-workflows",
      {
        schema: {
          params: Project,
          response: { 200: z.array(SessionArtifactSchema), ...errors },
        },
      },
      async (request, reply) => {
        if (!ctx.core)
          return reply
            .status(503)
            .send({ error: "Private workflows are unavailable" });
        return ctx.core.sessionArtifacts.list({
          ...request.params,
          identity: resolveIdentity(request),
          lifetime: "member",
        });
      },
    );
    typed.post(
      "/projects/:projectId/private-workflows",
      {
        bodyLimit: 6 * 1024 * 1024,
        schema: {
          params: Project,
          body: z.object({
            name: z.string().min(1).max(100),
            title: z.string().max(200).optional(),
            source: z.string().max(5 * 1024 * 1024),
            files: z.record(z.string(), z.string()).optional(),
          }),
          response: { 201: SessionArtifactSchema, ...errors },
        },
      },
      async (request, reply) => {
        if (!ctx.core)
          return reply
            .status(503)
            .send({ error: "Private workflows are unavailable" });
        return reply.status(201).send(
          await ctx.core.sessionArtifacts.create({
            ...request.params,
            ...request.body,
            identity: resolveIdentity(request),
            lifetime: "member",
            kind: "workflow",
          }),
        );
      },
    );
    typed.post(
      "/projects/:projectId/private-workflows/:artifactId/preview",
      {
        schema: {
          params: Artifact,
          body: Revision,
          response: { 200: WorkflowEnablementPreviewSchema, ...errors },
        },
      },
      async (request, reply) => {
        if (!ctx.core)
          return reply
            .status(503)
            .send({ error: "Private workflows are unavailable" });
        return ctx.core.privateWorkflows.preview({
          ...request.params,
          ...request.body,
          identity: resolveIdentity(request),
        });
      },
    );
    typed.post(
      "/projects/:projectId/private-workflows/:artifactId/activate",
      {
        schema: {
          params: Artifact,
          body: Revision.extend({ consentDigest: z.string() }),
          response: { 200: WorkflowEnablementSchema, ...errors },
        },
      },
      async (request, reply) => {
        if (!ctx.core)
          return reply
            .status(503)
            .send({ error: "Private workflows are unavailable" });
        return ctx.core.privateWorkflows.activate({
          ...request.params,
          ...request.body,
          identity: resolveIdentity(request),
        });
      },
    );
    typed.post(
      "/projects/:projectId/private-workflows/:artifactId/stop",
      {
        schema: {
          params: Artifact,
          response: { 200: z.object({ stopped: z.boolean() }), ...errors },
        },
      },
      async (request, reply) => {
        if (!ctx.core)
          return reply
            .status(503)
            .send({ error: "Private workflows are unavailable" });
        return ctx.core.privateWorkflows.stop({
          ...request.params,
          identity: resolveIdentity(request),
        });
      },
    );
    typed.post(
      "/projects/:projectId/private-workflows/:artifactId/run",
      {
        schema: {
          params: Artifact,
          body: Revision.extend({ input: JsonValueSchema.optional() }),
          response: { 200: RunSchema, ...errors },
        },
      },
      async (request, reply) => {
        if (!ctx.core)
          return reply
            .status(503)
            .send({ error: "Private workflows are unavailable" });
        return ctx.core.privateWorkflows.run({
          ...request.params,
          ...request.body,
          identity: resolveIdentity(request),
        });
      },
    );
  });
}
