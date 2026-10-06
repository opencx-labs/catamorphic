import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import {
  HTTP_REQUEST_MAX_BYTES,
  type HttpGatewayAdmission,
  type HttpGatewayResponse,
} from "@catamorphic/core";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { RouteContext } from "../app.js";

const HTTP_ROUTE = "/gateway/http/";

/** Admissions from `onRequest`, for the handler of the same request. */
const admissions = new WeakMap<IncomingMessage, HttpGatewayAdmission>();

/**
 * HTTP APIs through the gateway (ADR 0211), for code in sandboxes:
 * `<prefix>/gateway/http/<alias>` and anything below it, the API's own
 * requests below the connection's base URL with the session's grant as a
 * bearer, the Basic password, or `x-work-grant`. The grant is checked
 * before the body is read; the body travels byte for byte and answers
 * stream back as the API sent them. Hidden from the API spec: the API's
 * own clients speak it.
 */
export function registerHttpGatewayRoutes(
  app: FastifyInstance,
  ctx: RouteContext,
): void {
  app.register(async (http) => {
    http.removeAllContentTypeParsers();
    http.addContentTypeParser(
      "*",
      { parseAs: "buffer", bodyLimit: HTTP_REQUEST_MAX_BYTES },
      (_request, body, done) => done(null, body),
    );
    // Runs before Fastify reads a body, for this scope's routes only.
    http.addHook("onRequest", (request, reply) => admit(ctx, request, reply));
    const options = {
      config: { public: true },
      schema: { hide: true },
      bodyLimit: HTTP_REQUEST_MAX_BYTES,
    } as const;
    // The alias itself is the API's base URL (ClickHouse's `/?query=`).
    http.all(`${HTTP_ROUTE}:alias`, options, (request, reply) =>
      serve(ctx, request, reply),
    );
    http.all(`${HTTP_ROUTE}:alias/*`, options, (request, reply) =>
      serve(ctx, request, reply),
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
 * The alias, and what follows it in the path exactly as the caller sent
 * it (still percent-encoded, from its slash), from the raw URL: route
 * parameters arrive decoded.
 */
function routeTarget(request: FastifyRequest): {
  alias: string;
  path: string;
  query?: string;
} {
  const params = request.params as { alias?: string };
  const raw = request.raw.url ?? "";
  const mark = raw.indexOf("?");
  const pathname = mark < 0 ? raw : raw.slice(0, mark);
  const query = mark < 0 ? "" : raw.slice(mark + 1);
  const at = pathname.indexOf(HTTP_ROUTE);
  const rest = at < 0 ? "" : pathname.slice(at + HTTP_ROUTE.length);
  const slash = rest.indexOf("/");
  return {
    alias: params.alias ?? "",
    path: slash < 0 ? "" : rest.slice(slash),
    ...(query ? { query } : {}),
  };
}

function send(
  reply: FastifyReply,
  response: HttpGatewayResponse,
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
  const gateway = ctx.core?.httpGateway;
  if (!gateway) return undefined;
  const { alias } = routeTarget(request);
  const result = await gateway.admit({
    alias,
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
  const gateway = ctx.core?.httpGateway;
  if (!gateway)
    return reply
      .status(404)
      .type("application/json")
      .send({ error: { message: "This host has no HTTP gateway" } });
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
