import { Readable } from "node:stream";
import type { FastifyReply, FastifyRequest } from "fastify";
import { refreshRemoteCredentials } from "./remote-oauth.js";
import type { RemoteProjectsStore } from "./remote-projects-store.js";

/** Desktop transport only. The remote resolves identity and enforces policy. */
export async function forwardRemoteApi(args: {
  request: FastifyRequest;
  reply: FastifyReply;
  profiles: {
    forProject(projectId: string): { remoteProjects: RemoteProjectsStore };
  };
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
    const send = async (forceRefresh = false) => {
      const token = await store.accessToken(args.projectId, {
        forceRefresh,
        refresh: (credentials) => refreshRemoteCredentials({ credentials }),
      });
      return fetch(target, {
        method: args.request.method,
        headers: {
          authorization: `Bearer ${token}`,
          "x-catamorphic-runner": link.connectionId,
          ...(args.request.headers["content-type"]
            ? { "content-type": args.request.headers["content-type"] }
            : {}),
          ...(args.request.headers.accept
            ? { accept: args.request.headers.accept }
            : {}),
        },
        body: serialized,
        redirect: "manual",
        signal: controller.signal,
      });
    };
    let response = await send();
    if (response.status === 401) {
      await response.body?.cancel();
      response = await send(true);
    }
    args.reply.status(response.status);
    for (const key of [
      "content-type",
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
