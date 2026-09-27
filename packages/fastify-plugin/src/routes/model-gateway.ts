import { Readable } from "node:stream";
import { MODEL_REQUEST_MAX_BYTES } from "@catamorphic/core";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { RouteContext } from "../app.js";

/**
 * Models through the gateway (ADR 0180), for harnesses in sandboxes:
 * `<prefix>/gateway/model/<alias>/v1/messages` (Anthropic) or
 * `<prefix>/gateway/model/<alias>/responses` (OpenAI), the provider's own
 * HTTP API with the session's grant as its key. Answers stream back as the
 * provider sent them. Hidden from the API spec: model clients speak it.
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
  const params = request.params as { alias?: string; "*"?: string };
  const headers: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(request.headers))
    headers[name] = Array.isArray(value) ? value.join(", ") : value;
  const query = request.raw.url?.split("?", 2)[1];
  const response = await gateway.handle({
    alias: params.alias ?? "",
    path: params["*"] ?? "",
    method,
    headers,
    ...(query ? { query } : {}),
    ...(Buffer.isBuffer(request.body)
      ? { body: new Uint8Array(request.body) }
      : {}),
  });
  reply.status(response.status);
  for (const [name, value] of Object.entries(response.headers))
    reply.header(name, value);
  return reply.send(
    response.body instanceof Uint8Array
      ? Buffer.from(response.body)
      : Readable.from(response.body),
  );
}
