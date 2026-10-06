import { Readable } from "node:stream";
import type { FastifyReply, FastifyRequest } from "fastify";
import { refreshRemoteCredentials } from "./remote-oauth.js";
import type { RemoteProjectsStore } from "./remote-projects-store.js";
import type { RemoteTerminalRequest } from "./remote-terminal.js";
import { DESKTOP_API_TOKEN_HEADER } from "./server/local-api-guard.js";

/** Where the desktop finds each linked project's server and credentials. */
export interface RemoteProjectProfiles {
  forProject(projectId: string): { remoteProjects: RemoteProjectsStore };
}

/** The member is not signed in to the project's server. */
export class RemoteSignInRequiredError extends Error {
  constructor() {
    super("Sign in to this project's server to continue");
    this.name = "RemoteSignInRequiredError";
  }
}

/**
 * One request to a linked project's server as its member (ADR 0055): the
 * local project id in the path (and in an `agentId` query) becomes the
 * remote one, and the member's bearer is added, refreshed once on a 401.
 * Undefined when the project has no remote.
 */
export async function remoteProjectFetch(args: {
  profiles: RemoteProjectProfiles;
  projectId: string;
  /** Below the server's API base, e.g. `/projects/<local id>/...`. */
  apiPath: string;
  method: string;
  headers?: Record<string, string>;
  body?: Buffer | string;
  signal?: AbortSignal;
}): Promise<{ response: Response; target: URL } | undefined> {
  const store = args.profiles.forProject(args.projectId).remoteProjects;
  const inspected = store.inspect(args.projectId);
  if (!inspected) return undefined;
  if (!inspected.credentials) throw new RemoteSignInRequiredError();
  const link = inspected.link;
  const upstreamPath = args.apiPath.replace(
    `/projects/${args.projectId}`,
    `/projects/${link.remoteProjectId}`,
  );
  const target = new URL(
    `${link.serverUrl.replace(/\/+$/, "")}${upstreamPath}`,
  );
  const agentQuery = target.searchParams.get("agentId");
  if (agentQuery)
    target.searchParams.set(
      "agentId",
      agentQuery.replace(
        `project:${args.projectId}:`,
        `project:${link.remoteProjectId}:`,
      ),
    );
  const send = async (forceRefresh = false) => {
    const token = await store.accessToken(args.projectId, {
      forceRefresh,
      refresh: (credentials) => refreshRemoteCredentials({ credentials }),
    });
    return fetch(target, {
      method: args.method,
      headers: {
        // This computer's own API credential never leaves it.
        ...Object.fromEntries(
          Object.entries(args.headers ?? {}).filter(
            ([name]) => name.toLowerCase() !== DESKTOP_API_TOKEN_HEADER,
          ),
        ),
        authorization: `Bearer ${token}`,
        "x-catamorphic-runner": link.connectionId,
      },
      body: args.body,
      redirect: "manual",
      ...(args.signal ? { signal: args.signal } : {}),
    });
  };
  let response = await send();
  if (response.status === 401) {
    await response.body?.cancel();
    response = await send(true);
  }
  return { response, target };
}

/**
 * JSON requests to a remote chat's terminals on its project's server
 * (ADR 0208), or undefined when the project has no server.
 */
export function remoteTerminalRequest(args: {
  profiles: RemoteProjectProfiles;
  projectId: string;
  sessionId: string;
}): RemoteTerminalRequest | undefined {
  const linked = args.profiles
    .forProject(args.projectId)
    .remoteProjects.inspect(args.projectId);
  if (!linked) return undefined;
  return async (request) => {
    const sent = await remoteProjectFetch({
      profiles: args.profiles,
      projectId: args.projectId,
      apiPath: `/projects/${args.projectId}/agent/sessions/${args.sessionId}/terminals${request.path}`,
      method: request.method,
      ...(request.body === undefined
        ? {}
        : {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(request.body),
          }),
      ...(request.signal ? { signal: request.signal } : {}),
    });
    if (!sent)
      return {
        status: 404,
        body: { error: "This project is no longer linked to its server." },
      };
    return {
      status: sent.response.status,
      body: jsonBody(await sent.response.text()),
    };
  };
}

function jsonBody(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { error: text.slice(0, 500) };
  }
}

/** Desktop transport only. The remote resolves identity and enforces policy. */
export async function forwardRemoteApi(args: {
  request: FastifyRequest;
  reply: FastifyReply;
  profiles: RemoteProjectProfiles;
  projectId: string;
  apiPath: string;
}): Promise<boolean> {
  const store = args.profiles.forProject(args.projectId).remoteProjects;
  const inspected = store.inspect(args.projectId);
  if (!inspected) return false;
  if (!inspected.credentials) {
    await args.reply
      .status(401)
      .send({ error: "Sign in to this project's server to continue" });
    return true;
  }
  const link = inspected.link;
  const body = args.request.body;
  const serialized =
    body === undefined
      ? undefined
      : Buffer.isBuffer(body)
        ? body
        : JSON.stringify(
            remapAgentIds(body, args.projectId, link.remoteProjectId),
          );
  const controller = new AbortController();
  const disconnect = () => {
    if (!args.reply.raw.writableEnded) controller.abort();
  };
  args.reply.raw.once("close", disconnect);
  try {
    const sent = await remoteProjectFetch({
      profiles: args.profiles,
      projectId: args.projectId,
      apiPath: args.apiPath,
      method: args.request.method,
      headers: {
        ...(args.request.headers["content-type"]
          ? { "content-type": args.request.headers["content-type"] }
          : {}),
        ...(args.request.headers.accept
          ? { accept: args.request.headers.accept }
          : {}),
      },
      ...(serialized === undefined ? {} : { body: serialized }),
      signal: controller.signal,
    });
    if (!sent) return false;
    const { response, target } = sent;
    args.reply.status(response.status);
    for (const key of [
      "content-type",
      "content-security-policy",
      "cache-control",
      "etag",
      "retry-after",
      "www-authenticate",
    ]) {
      const value = response.headers.get(key);
      if (value) args.reply.header(key, value);
    }
    // Stream events without waiting for completion; all authority stays remote.
    if (
      response.headers.get("content-type")?.includes("text/event-stream") &&
      response.body
    ) {
      await args.reply.send(Readable.fromWeb(response.body));
    } else if (/\/apps\/[^/]+\/view-state$/.test(target.pathname)) {
      // The app document loads in a frame, which carries no bearer: point
      // its URL back through this proxy, which adds the member's token.
      const state: unknown = await response.json();
      await args.reply.send(
        proxiedGuestUrl({
          state,
          localBase: `${args.request.protocol}://${args.request.host}/desktop/projects/${encodeURIComponent(args.projectId)}/remote-api/api`,
          remoteProjectId: link.remoteProjectId,
          localProjectId: args.projectId,
        }),
      );
    } else {
      const bytes = Buffer.from(await response.arrayBuffer());
      await args.reply.send(bytes);
    }
    return true;
  } catch (error) {
    if (!args.reply.sent)
      await args.reply.status(502).send({
        error:
          error instanceof Error
            ? error.message
            : "The project server is unavailable",
      });
    return true;
  } finally {
    args.reply.raw.off("close", disconnect);
  }
}

/** A view-state whose guest URL goes through the desktop's proxy. */
export function proxiedGuestUrl(args: {
  state: unknown;
  localBase: string;
  remoteProjectId: string;
  localProjectId: string;
}): unknown {
  const state = args.state;
  if (
    typeof state !== "object" ||
    state === null ||
    !("guestUrl" in state) ||
    typeof state.guestUrl !== "string"
  )
    return state;
  const remote = new URL(state.guestUrl);
  const path = remote.pathname
    .replace(/^\/api/, "")
    .replace(
      `/projects/${args.remoteProjectId}/`,
      `/projects/${encodeURIComponent(args.localProjectId)}/`,
    );
  return { ...state, guestUrl: `${args.localBase}${path}${remote.search}` };
}

export function remapAgentIds(
  value: unknown,
  localProjectId: string,
  remoteProjectId: string,
): unknown {
  if (value && typeof value === "object" && !Array.isArray(value))
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        (key === "agentId" || key === "targetAgentId") &&
        typeof item === "string"
          ? item.replace(
              `project:${localProjectId}:`,
              `project:${remoteProjectId}:`,
            )
          : item,
      ]),
    );
  return value;
}
