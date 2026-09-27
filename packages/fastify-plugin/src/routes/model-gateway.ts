import { Readable } from "node:stream";
import {
  MODEL_REQUEST_MAX_BYTES,
  type ModelGatewayResponse,
} from "@catamorphic/core";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { RouteContext } from "../app.js";

/**
 * Models through the gateway (ADR 0180), for harnesses in sandboxes:
 * `<prefix>/gateway/model/<alias>/v1/messages` (Anthropic) or
 * `<prefix>/gateway/model/<alias>/responses` (OpenAI), the provider's own
 * HTTP API with the session's grant as its key. The grant is checked before
 * the body is read. Answers stream back as the provider sent them. Hidden
 * from the API spec: model clients speak it.
 */
export function registerModelGatewayRoutes(
  app: FastifyInstance,
  ctx: RouteContext,
): void {
  app.register(async (model) => {
    model.removeAllContentTypeParsers();
    model.addContentTypeParser(
      "*",
      { parseAs: "buffer", bodyLimit: MODEL_REQUEST_MAX_BYTES },
      (_request, body, done) => done(null, body),
    );
    // Runs before Fastify reads a body, for this scope's routes only.
    model.addHook("onRequest", (request, reply) => admit(ctx, request, reply));
    const options = {
      config: { public: true },
      schema: { hide: true },
      bodyLimit: MODEL_REQUEST_MAX_BYTES,
    } as const;
    model.get("/gateway/model/:alias/*", options, (request, reply) =>
      serve(ctx, request, reply, "GET"),
    );
    model.post("/gateway/model/:alias/*", options, (request, reply) =>
      serve(ctx, request, reply, "POST"),
    );
  });
}

function requestHeaders(
  request: FastifyRequest,
): Record<string, string | undefined> {
  const headers: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(request.headers))
    headers[name] = Array.isArray(value) ? value.join(", ") : value;
  return headers;
}

function routeParams(request: FastifyRequest): {
  alias: string;
  path: string;
} {
  const params = request.params as { alias?: string; "*"?: string };
  return { alias: params.alias ?? "", path: params["*"] ?? "" };
}

function send(
  reply: FastifyReply,
  response: ModelGatewayResponse,
): FastifyReply {
  reply.status(response.status);
  for (const [name, value] of Object.entries(response.headers))
    reply.header(name, value);
  return reply.send(
    response.body instanceof Uint8Array
      ? Buffer.from(response.body)
      : Readable.from(response.body),
  );
}

/** Refuse a caller without a valid grant before its body is read. */
async function admit(
  ctx: RouteContext,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply | undefined> {
  const gateway = ctx.core?.modelGateway;
  if (!gateway) return undefined;
  const refusal = await gateway.admit({
    ...routeParams(request),
    headers: requestHeaders(request),
  });
  if (!refusal) return undefined;
  // The unread body may still be arriving; close rather than drain it.
  reply.header("connection", "close");
  return send(reply, refusal);
}

async function serve(
  ctx: RouteContext,
  request: FastifyRequest,
  reply: FastifyReply,
  method: "GET" | "POST",
): Promise<FastifyReply> {
  const gateway = ctx.core?.modelGateway;
  if (!gateway)
    return reply
      .status(404)
      .type("application/json")
      .send({ error: { message: "This host has no model gateway" } });
  const query = request.raw.url?.split("?", 2)[1];
  const response = await gateway.handle({
    ...routeParams(request),
    method,
    headers: requestHeaders(request),
    ...(query ? { query } : {}),
    ...(Buffer.isBuffer(request.body)
      ? { body: new Uint8Array(request.body) }
      : {}),
  });
  return send(reply, response);
}
