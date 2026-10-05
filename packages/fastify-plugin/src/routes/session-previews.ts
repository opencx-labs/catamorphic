import {
  PREVIEW_REQUEST_MAX_BYTES,
  type PreviewResponse,
  SessionPreviewError,
} from "@catamorphic/core";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { RouteContext } from "../app.js";
import { resolveIdentity } from "../http-identity.js";
import { workspaceRefusal } from "./session-terminals.js";

const SESSION_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Hosts a server in the workspace calls itself in an absolute redirect. */
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "0.0.0.0", "[::1]"];

/** Response headers the route sets itself. */
const OWN_RESPONSE_HEADERS = ["content-length", "connection", "keep-alive"];

/**
 * Previews of servers running in a chat's workspace (ADR 0208):
 * `<prefix>/projects/:projectId/agent/sessions/:sessionId/previews/:port/*`,
 * any method, forwarded to that port inside the workspace by the
 * sandbox's own runtime. The body travels byte for byte; the answer comes
 * back with its status and headers, every `Set-Cookie` kept, and a
 * redirect to the server itself pointed back below the preview's prefix.
 * WebSocket upgrades are not forwarded. Hidden from the API spec: browsers
 * speak it, through a client that adds the member's credentials.
 */
export function registerSessionPreviewRoutes(
  app: FastifyInstance,
  ctx: RouteContext,
): void {
  app.register(async (previews) => {
    previews.removeAllContentTypeParsers();
    previews.addContentTypeParser(
      "*",
      { parseAs: "buffer", bodyLimit: PREVIEW_REQUEST_MAX_BYTES },
      (_request, body, done) => done(null, body),
    );
    // `/previews/3000` gets its slash, so the page's relative URLs land
    // below the preview.
    previews.get(
      "/projects/:projectId/agent/sessions/:sessionId/previews/:port",
      { schema: { hide: true } },
      (request, reply) => {
        const [pathname = "", query] = (request.raw.url ?? "").split("?", 2);
        return reply.redirect(
          `${pathname}/${query === undefined ? "" : `?${query}`}`,
          308,
        );
      },
    );
    previews.all(
      "/projects/:projectId/agent/sessions/:sessionId/previews/:port/*",
      {
        schema: { hide: true },
        bodyLimit: PREVIEW_REQUEST_MAX_BYTES,
      },
      (request, reply) => serve(ctx, request, reply),
    );
  });
}

async function serve(
  ctx: RouteContext,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const previews = ctx.core?.sessionPreviews;
  if (!previews)
    return reply.status(503).send({ error: "Agent sessions not configured" });
  const params = request.params as {
    projectId?: string;
    sessionId?: string;
    port?: string;
  };
  const port = Number(params.port);
  if (
    !SESSION_UUID.test(params.projectId ?? "") ||
    !SESSION_UUID.test(params.sessionId ?? "") ||
    !/^\d{1,5}$/.test(params.port ?? "") ||
    port < 1 ||
    port > 65535
  )
    return reply.status(400).send({ error: "Invalid preview address" });
  const target = previewTarget({ url: request.raw.url ?? "", port });
  if (!target)
    return reply.status(400).send({ error: "Invalid preview address" });
  try {
    const response = await previews.request({
      identity: resolveIdentity(request),
      projectId: params.projectId ?? "",
      sessionId: params.sessionId ?? "",
      port,
      method: request.method,
      path: target.path,
      headers: requestHeaderPairs(request),
      ...(Buffer.isBuffer(request.body) && request.body.byteLength > 0
        ? {
            body: new Uint8Array(
              request.body.buffer,
              request.body.byteOffset,
              request.body.byteLength,
            ),
          }
        : {}),
    });
    return send({ reply, response, prefix: target.prefix, port });
  } catch (error) {
    if (error instanceof SessionPreviewError)
      return reply
        .status(error.reason === "invalid" ? 400 : 502)
        .send({ error: error.message, code: error.reason });
    const refused = workspaceRefusal(reply, error);
    if (refused) return refused;
    throw error;
  }
}

/**
 * The preview's prefix (everything through `/previews/<port>`, as the
 * caller addressed it) and the path below it, still percent-encoded.
 */
export function previewTarget(input: {
  url: string;
  port: number;
}): { prefix: string; path: string } | undefined {
  const [pathname = "", query] = input.url.split("?", 2);
  const marker = `/previews/${input.port}`;
  const at = pathname.indexOf(`${marker}/`);
  if (at < 0) return undefined;
  const prefix = pathname.slice(0, at + marker.length);
  const rest = pathname.slice(prefix.length) || "/";
  return {
    prefix,
    path: `${rest}${query === undefined ? "" : `?${query}`}`,
  };
}

/**
 * A redirect within the previewed server, below the preview's prefix: a
 * root-relative location, or an absolute one naming the server itself on
 * a loopback host. Anything else (relative, elsewhere) is left alone.
 */
export function rewritePreviewLocation(input: {
  location: string;
  prefix: string;
  port: number;
}): string {
  const { location, prefix } = input;
  if (location.startsWith("/") && !location.startsWith("//"))
    return `${prefix}${location}`;
  let parsed: URL;
  try {
    parsed = new URL(location);
  } catch {
    return location;
  }
  const defaultPort = parsed.protocol === "https:" ? 443 : 80;
  const port = parsed.port ? Number(parsed.port) : defaultPort;
  if (
    (parsed.protocol === "http:" || parsed.protocol === "https:") &&
    LOOPBACK_HOSTS.includes(parsed.hostname) &&
    port === input.port
  )
    return `${prefix}${parsed.pathname}${parsed.search}${parsed.hash}`;
  return location;
}

function requestHeaderPairs(request: FastifyRequest): Array<[string, string]> {
  const raw = request.raw.rawHeaders;
  const pairs: Array<[string, string]> = [];
  for (let index = 0; index + 1 < raw.length; index += 2) {
    const name = raw[index];
    const value = raw[index + 1];
    if (name !== undefined && value !== undefined) pairs.push([name, value]);
  }
  return pairs;
}

function send(input: {
  reply: FastifyReply;
  response: PreviewResponse;
  prefix: string;
  port: number;
}): FastifyReply {
  const { reply, response } = input;
  reply.status(response.status);
  const grouped = new Map<string, string[]>();
  for (const [name, value] of response.headers) {
    const key = name.toLowerCase();
    if (OWN_RESPONSE_HEADERS.includes(key)) continue;
    const values = grouped.get(key) ?? [];
    values.push(
      key === "location"
        ? rewritePreviewLocation({
            location: value,
            prefix: input.prefix,
            port: input.port,
          })
        : value,
    );
    grouped.set(key, values);
  }
  for (const [name, values] of grouped)
    reply.header(name, name === "set-cookie" ? values : values.join(", "));
  return reply.send(Buffer.from(response.body));
}
