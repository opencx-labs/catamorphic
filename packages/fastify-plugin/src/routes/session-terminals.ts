import {
  AgentSessionNotFoundError,
  EnvironmentBindingUnavailableError,
  EnvironmentCapacityError,
  EnvironmentNotFoundError,
  SessionTerminalNotFoundError,
  SessionWorkspaceUnavailableError,
} from "@catamorphic/core";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { RouteContext } from "../app.js";
import { resolveIdentity } from "../http-identity.js";
import {
  AgentSessionIdParamsSchema,
  ErrorSchema,
  OkSchema,
  OpenSessionTerminalSchema,
  ResizeSessionTerminalSchema,
  SessionTerminalInputSchema,
  SessionTerminalOutputQuerySchema,
  SessionTerminalOutputSchema,
  SessionTerminalParamsSchema,
  SessionTerminalSchema,
  SessionWorkspaceErrorSchema,
} from "../schemas.js";

const NOT_CONFIGURED = { error: "Agent sessions not configured" };

/**
 * The answer for what stops a person from working in a chat's workspace,
 * or undefined for any other error. Shared with the preview routes.
 */
export function workspaceRefusal(
  reply: FastifyReply,
  error: unknown,
): FastifyReply | undefined {
  if (
    error instanceof AgentSessionNotFoundError ||
    error instanceof SessionTerminalNotFoundError
  )
    return reply.status(404).send({ error: error.message });
  if (error instanceof SessionWorkspaceUnavailableError)
    return reply.status(409).send({ error: error.message, code: error.reason });
  if (error instanceof EnvironmentCapacityError)
    return reply
      .status(409)
      .send({ error: error.message, code: "environment_full" });
  if (
    error instanceof EnvironmentBindingUnavailableError ||
    error instanceof EnvironmentNotFoundError
  )
    return reply
      .status(409)
      .send({ error: error.message, code: "environment_unavailable" });
  return undefined;
}

/**
 * Terminals in a chat's workspace (ADR 0208): open one (starting the
 * workspace when it was given back), read its output by cursor with a
 * wait, type into it, resize it, close it. Only the person who opened a
 * terminal reaches it.
 */
export function registerSessionTerminalRoutes(
  app: FastifyInstance,
  ctx: RouteContext,
) {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const conflicts = {
    403: ErrorSchema,
    404: ErrorSchema,
    409: SessionWorkspaceErrorSchema,
    503: ErrorSchema,
  };

  typed.route({
    method: "POST",
    url: "/projects/:projectId/agent/sessions/:sessionId/terminals",
    schema: {
      params: AgentSessionIdParamsSchema,
      body: OpenSessionTerminalSchema,
      response: { 201: SessionTerminalSchema, ...conflicts },
    },
    handler: async (request, reply) => {
      const terminals = ctx.core?.sessionTerminals;
      if (!terminals) return reply.status(503).send(NOT_CONFIGURED);
      try {
        const terminal = await terminals.open({
          identity: resolveIdentity(request),
          ...request.params,
          ...request.body,
        });
        return reply.status(201).send(terminal);
      } catch (error) {
        const refused = workspaceRefusal(reply, error);
        if (refused) return refused;
        throw error;
      }
    },
  });

  typed.route({
    method: "GET",
    url: "/projects/:projectId/agent/sessions/:sessionId/terminals/:terminalId/output",
    schema: {
      params: SessionTerminalParamsSchema,
      querystring: SessionTerminalOutputQuerySchema,
      response: { 200: SessionTerminalOutputSchema, ...conflicts },
    },
    handler: async (request, reply) => {
      const terminals = ctx.core?.sessionTerminals;
      if (!terminals) return reply.status(503).send(NOT_CONFIGURED);
      try {
        return reply.send(
          await terminals.read({
            identity: resolveIdentity(request),
            ...request.params,
            ...request.query,
          }),
        );
      } catch (error) {
        const refused = workspaceRefusal(reply, error);
        if (refused) return refused;
        throw error;
      }
    },
  });

  typed.route({
    method: "POST",
    url: "/projects/:projectId/agent/sessions/:sessionId/terminals/:terminalId/input",
    schema: {
      params: SessionTerminalParamsSchema,
      body: SessionTerminalInputSchema,
      response: { 200: OkSchema, 413: ErrorSchema, ...conflicts },
    },
    handler: async (request, reply) => {
      const terminals = ctx.core?.sessionTerminals;
      if (!terminals) return reply.status(503).send(NOT_CONFIGURED);
      try {
        await terminals.write({
          identity: resolveIdentity(request),
          ...request.params,
          data: request.body.data,
        });
        return reply.send({ ok: true });
      } catch (error) {
        if (error instanceof RangeError)
          return reply.status(413).send({ error: error.message });
        const refused = workspaceRefusal(reply, error);
        if (refused) return refused;
        throw error;
      }
    },
  });

  typed.route({
    method: "POST",
    url: "/projects/:projectId/agent/sessions/:sessionId/terminals/:terminalId/resize",
    schema: {
      params: SessionTerminalParamsSchema,
      body: ResizeSessionTerminalSchema,
      response: { 200: OkSchema, ...conflicts },
    },
    handler: async (request, reply) => {
      const terminals = ctx.core?.sessionTerminals;
      if (!terminals) return reply.status(503).send(NOT_CONFIGURED);
      try {
        await terminals.resize({
          identity: resolveIdentity(request),
          ...request.params,
          ...request.body,
        });
        return reply.send({ ok: true });
      } catch (error) {
        const refused = workspaceRefusal(reply, error);
        if (refused) return refused;
        throw error;
      }
    },
  });

  typed.route({
    method: "DELETE",
    url: "/projects/:projectId/agent/sessions/:sessionId/terminals/:terminalId",
    schema: {
      params: SessionTerminalParamsSchema,
      response: { 200: OkSchema, ...conflicts },
    },
    handler: async (request, reply) => {
      const terminals = ctx.core?.sessionTerminals;
      if (!terminals) return reply.status(503).send(NOT_CONFIGURED);
      try {
        await terminals.close({
          identity: resolveIdentity(request),
          ...request.params,
        });
        return reply.send({ ok: true });
      } catch (error) {
        const refused = workspaceRefusal(reply, error);
        if (refused) return refused;
        throw error;
      }
    },
  });
}
