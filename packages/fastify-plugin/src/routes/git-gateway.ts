import { Readable } from "node:stream";
import {
  checkoutTarget,
  type GitGatewayOperation,
  type GitGatewayResponse,
} from "@catamorphic/core";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { RouteContext } from "../app.js";

/**
 * Git smart HTTP through the gateway (ADR 0175), for sandboxes' `git`:
 * `<prefix>/gateway/git/<alias>/<repository>/info/refs`,
 * `.../git-upload-pack`, and `.../git-receive-pack`. The password (or a
 * bearer) is the session's grant; bodies stream both ways and are never
 * parsed by Fastify. Hidden from the API spec: Git clients speak it.
 */
export function registerGitGatewayRoutes(
  app: FastifyInstance,
  ctx: RouteContext,
): void {
  app.register(async (git) => {
    git.removeAllContentTypeParsers();
    git.addContentTypeParser("*", (_request, _payload, done) => done(null));
    const options = {
      config: { public: true },
      schema: { hide: true },
    } as const;
    git.get("/gateway/git/:alias/*", options, (request, reply) =>
      serve(ctx, request, reply, "GET"),
    );
    git.post("/gateway/git/:alias/*", options, (request, reply) =>
      serve(ctx, request, reply, "POST"),
    );
    // A workspace's base, served by Work itself (ADR 0353):
    // `<prefix>/gateway/checkout/<id>/info/refs` and `.../git-upload-pack`,
    // with the checkout's token as the bearer.
    git.get("/gateway/checkout/*", options, (request, reply) =>
      serveCheckout(ctx, request, reply, "GET"),
    );
    git.post("/gateway/checkout/*", options, (request, reply) =>
      serveCheckout(ctx, request, reply, "POST"),
    );
  });
}

async function serveCheckout(
  ctx: RouteContext,
  request: FastifyRequest,
  reply: FastifyReply,
  method: "GET" | "POST",
): Promise<FastifyReply> {
  const checkouts = ctx.core?.workspaceCheckouts;
  if (!checkouts)
    return reply
      .status(404)
      .type("text/plain")
      .send("This host serves no checkouts\n");
  const params = request.params as { "*"?: string };
  const query = request.query as { service?: string };
  const target = checkoutTarget({
    method,
    path: params["*"] ?? "",
    service: query.service,
  });
  if (!target)
    return reply.status(404).type("text/plain").send("Not a Git request\n");
  const headers: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(request.headers))
    headers[name] = Array.isArray(value) ? value.join(", ") : value;
  return send(
    reply,
    method,
    await checkouts.handle({
      id: target.id,
      operation: target.operation,
      authorization: headers.authorization,
      headers,
      ...(method === "POST" ? { body: request.raw } : {}),
    }),
  );
}

/** Send a gateway's answer, streamed. */
function send(
  reply: FastifyReply,
  method: "GET" | "POST",
  response: GitGatewayResponse,
): FastifyReply {
  reply.status(response.status);
  for (const [name, value] of Object.entries(response.headers))
    reply.header(name, value);
  // A refused upload may still be arriving; closing lets the client see
  // the answer instead of waiting to finish sending.
  if (method === "POST" && response.status >= 400)
    reply.header("connection", "close");
  return reply.send(
    response.body instanceof Uint8Array
      ? Buffer.from(response.body)
      : Readable.from(response.body),
  );
}

async function serve(
  ctx: RouteContext,
  request: FastifyRequest,
  reply: FastifyReply,
  method: "GET" | "POST",
): Promise<FastifyReply> {
  const gateway = ctx.core?.gitGateway;
  if (!gateway)
    return reply
      .status(404)
      .type("text/plain")
      .send("This host has no Git gateway\n");
  const params = request.params as { alias?: string; "*"?: string };
  const alias = params.alias ?? "";
  const rest = params["*"] ?? "";
  const query = request.query as { service?: string };
  const target = gitTarget({ method, path: rest, service: query.service });
  if (!target)
    return reply.status(404).type("text/plain").send("Not a Git request\n");
  const headers: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(request.headers))
    headers[name] = Array.isArray(value) ? value.join(", ") : value;
  return send(
    reply,
    method,
    await gateway.handle({
      alias,
      repositoryPath: target.repositoryPath,
      operation: target.operation,
      authorization: headers.authorization,
      headers,
      ...(method === "POST" ? { body: request.raw } : {}),
    }),
  );
}

/** The operation and repository a smart-HTTP path names. */
export function gitTarget(input: {
  method: "GET" | "POST";
  path: string;
  service: string | undefined;
}): { repositoryPath: string; operation: GitGatewayOperation } | null {
  const path = input.path.replace(/\/+$/, "");
  if (input.method === "GET" && path.endsWith("/info/refs")) {
    if (
      input.service !== "git-upload-pack" &&
      input.service !== "git-receive-pack"
    )
      return null;
    return {
      repositoryPath: path.slice(0, -"/info/refs".length),
      operation: { kind: "advertise", service: input.service },
    };
  }
  if (input.method === "POST" && path.endsWith("/git-upload-pack"))
    return {
      repositoryPath: path.slice(0, -"/git-upload-pack".length),
      operation: { kind: "upload-pack" },
    };
  if (input.method === "POST" && path.endsWith("/git-receive-pack"))
    return {
      repositoryPath: path.slice(0, -"/git-receive-pack".length),
      operation: { kind: "receive-pack" },
    };
  return null;
}
