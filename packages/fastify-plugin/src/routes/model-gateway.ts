import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import {
  MODEL_REQUEST_MAX_BYTES,
  type ModelGatewayAdmission,
  type ModelGatewayResponse,
} from "@catamorphic/core";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { RouteContext } from "../app.js";

const MODEL_ROUTE = "/gateway/model/";

/** Admissions from `onRequest`, for the handler of the same request. */
const admissions = new WeakMap<IncomingMessage, ModelGatewayAdmission>();

/**
 * Models through the gateway (ADR 0180), for harnesses in sandboxes:
 * `<prefix>/gateway/model/<alias>/<any path below the provider's base URL>`,
 * the provider's own HTTP API with the session's grant as its key, any
 * method. The grant is checked before the body is read; the body travels
 * byte for byte and answers stream back as the provider sent them. Hidden
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
    model.all(
      `${MODEL_ROUTE}:alias/*`,
      {
        config: { public: true },
        schema: { hide: true },
        bodyLimit: MODEL_REQUEST_MAX_BYTES,
      },
      (request, reply) => serve(ctx, request, reply),
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

/**
 * The alias, and the path below it exactly as the caller sent it (still
 * percent-encoded), from the raw URL: route parameters arrive decoded.
 */
function routeTarget(request: FastifyRequest): {
  alias: string;
  path: string;
  query?: string;
} {
  const params = request.params as { alias?: string };
  const [pathname = "", query] = (request.raw.url ?? "").split("?", 2);
  const at = pathname.indexOf(MODEL_ROUTE);
  const rest = at < 0 ? "" : pathname.slice(at + MODEL_ROUTE.length);
  const slash = rest.indexOf("/");
  return {
    alias: params.alias ?? "",
    path: slash < 0 ? "" : rest.slice(slash + 1),
    ...(query ? { query } : {}),
  };
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
  const { alias, path } = routeTarget(request);
  const result = await gateway.admit({
    alias,
    path,
    headers: requestHeaders(request),
  });
  if ("admitted" in result) {
    admissions.set(request.raw, result.admitted);
    return undefined;
  }
  // The unread body may still be arriving; close rather than drain it.
  reply.header("connection", "close");
  return send(reply, result.refused);
}

async function serve(
  ctx: RouteContext,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const gateway = ctx.core?.modelGateway;
  if (!gateway)
    return reply
      .status(404)
      .type("application/json")
      .send({ error: { message: "This host has no model gateway" } });
  const admitted = admissions.get(request.raw);
  admissions.delete(request.raw);
  const response = await gateway.handle({
    ...routeTarget(request),
    method: request.method,
    headers: requestHeaders(request),
    ...(Buffer.isBuffer(request.body)
      ? {
          body: new Uint8Array(
            request.body.buffer,
            request.body.byteOffset,
            request.body.byteLength,
          ),
        }
      : {}),
    ...(admitted ? { admitted } : {}),
  });
  return send(reply, response);
}
