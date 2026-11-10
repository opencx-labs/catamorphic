import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  safeStorage: {
    getSelectedStorageBackend: () => "gnome_libsecret",
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString(),
  },
}));

import {
  forwardRemoteApi,
  proxiedGuestUrl,
  remoteMachinesRequest,
} from "./remote-api.js";
import { RemoteProjectsStore } from "./remote-projects-store.js";

it("routes a linked project under the member token and never falls through to local root", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cat-remote-api-"));
  const remote = Fastify();
  const local = Fastify();
  const bodies: unknown[] = [];
  remote.post("/api/projects/remote/agent/sessions", async (request, reply) => {
    expect(request.headers.authorization).toBe("Bearer member-token");
    expect(request.headers["x-catamorphic-runner"]).toBe("runner-id");
    bodies.push(request.body);
    return reply.status(403).send({ error: "Member cannot run this agent" });
  });
  const base = await remote.listen({ port: 0, host: "127.0.0.1" });
  const store = new RemoteProjectsStore(path.join(directory, "remote.json"));
  store.set("local", {
    connectionId: "runner-id",
    serverUrl: `${base}/api`,
    remoteProjectId: "remote",
    remoteProjectName: "Company",
    lastSyncAt: null,
    credentials: {
      clientId: "client",
      accessToken: "member-token",
      refreshToken: "refresh-token",
      accessTokenExpiresAt: new Date(Date.now() + 3600000).toISOString(),
      tokenEndpoint: `${base}/token`,
      scope: "openid",
    },
  });
  let rootCalls = 0;
  local.post("/api/projects/local/agent/sessions", async (request, reply) => {
    const forwarded = await forwardRemoteApi({
      request,
      reply,
      profiles: { forProject: () => ({ remoteProjects: store }) },
      projectId: "local",
      apiPath: request.url.slice(4),
    });
    if (!forwarded) {
      rootCalls += 1;
      return { id: "wrong-local-session" };
    }
  });
  try {
    const result = await local.inject({
      method: "POST",
      url: "/api/projects/local/agent/sessions",
      headers: { authorization: "Bearer desktop-root" },
      payload: {
        agentId: "project:local:helper",
        input: { agentId: "project:local:user-data" },
      },
    });
    expect(result.statusCode).toBe(403);
    expect(rootCalls).toBe(0);
    expect(bodies).toEqual([
      {
        agentId: "project:remote:helper",
        input: { agentId: "project:local:user-data" },
      },
    ]);
    expect(result.body).not.toContain("member-token");
  } finally {
    await local.close();
    await remote.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it("asks the project's server for the member's own machines with the member token", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cat-remote-api-"));
  const remote = Fastify();
  remote.get("/api/work/me/machines", async (request) => {
    expect(request.headers.authorization).toBe("Bearer member-token");
    return { machines: [] };
  });
  remote.post(
    "/api/work/me/machines/:id/codex/sign-in",
    async (request, reply) => {
      expect(request.params).toEqual({ id: "m-1" });
      return reply.status(409).send({
        error: "ada-devbox is not connected.",
        code: "machine_offline",
      });
    },
  );
  const base = await remote.listen({ port: 0, host: "127.0.0.1" });
  const store = new RemoteProjectsStore(path.join(directory, "remote.json"));
  store.set("local", {
    connectionId: "runner-id",
    serverUrl: `${base}/api`,
    remoteProjectId: "remote",
    remoteProjectName: "Company",
    lastSyncAt: null,
    credentials: {
      clientId: "client",
      accessToken: "member-token",
      refreshToken: "refresh-token",
      accessTokenExpiresAt: new Date(Date.now() + 3600000).toISOString(),
      tokenEndpoint: `${base}/token`,
      scope: "openid",
    },
  });
  const profiles = { forProject: () => ({ remoteProjects: store }) };
  try {
    const request = remoteMachinesRequest({ profiles, projectId: "local" });
    expect(await request({ method: "GET", path: "" })).toEqual({
      status: 200,
      body: { machines: [] },
    });
    expect(
      await request({ method: "POST", path: "/m-1/codex/sign-in" }),
    ).toEqual({
      status: 409,
      body: {
        error: "ada-devbox is not connected.",
        code: "machine_offline",
      },
    });
    // A project that lost its link answers as a server without the route.
    expect(
      await remoteMachinesRequest({ profiles, projectId: "other" })({
        method: "GET",
        path: "",
      }),
    ).toEqual({
      status: 404,
      body: { error: "This project is no longer linked to its server." },
    });
  } finally {
    await remote.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function remoteStreamFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cat-remote-api-"));
  const local = Fastify({ forceCloseConnections: true });
  const store = new RemoteProjectsStore(path.join(directory, "remote.json"));
  store.set("local", {
    connectionId: "runner-id",
    serverUrl: "http://remote.example/api",
    remoteProjectId: "remote",
    remoteProjectName: "Company",
    lastSyncAt: null,
    credentials: {
      clientId: "client",
      accessToken: "member-token",
      refreshToken: "refresh-token",
      accessTokenExpiresAt: new Date(Date.now() + 3600000).toISOString(),
      tokenEndpoint: "http://remote.example/token",
      scope: "openid",
    },
  });
  const started = deferred<RequestInit | undefined>();
  const forwarded = deferred<void>();
  const source = deferred<ReadableStreamDefaultController<Uint8Array>>();
  const cancelled = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start: source.resolve,
    cancel: cancelled,
  });
  const clientFetch = globalThis.fetch;
  const upstream = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (_url, options) => {
      started.resolve(options);
      return new Response(body, {
        headers: { "content-type": "text/event-stream" },
      });
    });
  const rootHandler = vi.fn(
    async (_request: FastifyRequest, reply: FastifyReply) => {
      // A sentinel for the local-authority route that must never run.
      reply.hijack();
    },
  );
  local.addHook("preHandler", async (request, reply) => {
    await forwardRemoteApi({
      request,
      reply,
      profiles: { forProject: () => ({ remoteProjects: store }) },
      projectId: "local",
      apiPath: request.url.slice(4),
    });
    forwarded.resolve();
  });
  local.get("/api/projects/local/events", rootHandler);
  const base = await local.listen({ port: 0, host: "127.0.0.1" });
  const client = new AbortController();
  return {
    source: await source.promise,
    started: started.promise,
    forwarded: async () => {
      await forwarded.promise;
      // Fastify resumes its preHandler chain after the forwarding hook settles.
      await setImmediate();
    },
    rootHandler,
    cancelled,
    client,
    request: () =>
      clientFetch(`${base}/api/projects/local/events`, {
        signal: client.signal,
      }),
    close: async () => {
      client.abort();
      await local.close();
      upstream.mockRestore();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

describe("remote event-stream lifecycle", () => {
  it.each([false, true])(
    "keeps a disconnected stream under remote authority (first event sent: %s)",
    async (sendEvent) => {
      const fixture = await remoteStreamFixture();
      try {
        const pending = fixture.request();
        const request = await fixture.started;
        if (sendEvent) {
          fixture.source.enqueue(new TextEncoder().encode("data: ready\n\n"));
          const response = await pending;
          expect(response.status).toBe(200);
          expect(await response.body?.getReader().read()).toEqual({
            done: false,
            value: new TextEncoder().encode("data: ready\n\n"),
          });
        }
        fixture.client.abort();
        if (!sendEvent) await expect(pending).rejects.toThrow();
        await fixture.forwarded();
        expect(request?.signal?.aborted).toBe(true);
        expect(fixture.cancelled).toHaveBeenCalledOnce();
        expect(fixture.rootHandler).not.toHaveBeenCalled();
      } finally {
        await fixture.close();
      }
    },
  );

  it("keeps a failed upstream stream under remote authority after its headers were sent", async () => {
    const fixture = await remoteStreamFixture();
    try {
      const pending = fixture.request();
      await fixture.started;
      fixture.source.enqueue(new TextEncoder().encode("data: ready\n\n"));
      const response = await pending;
      const reader = response.body?.getReader();
      expect((await reader?.read())?.done).toBe(false);
      fixture.source.error(new Error("Upstream stream failed"));
      await expect(reader?.read()).rejects.toThrow();
      await fixture.forwarded();
      expect(fixture.rootHandler).not.toHaveBeenCalled();
    } finally {
      await fixture.close();
    }
  });

  it("answers an upstream stream failure before its first event without falling through", async () => {
    const fixture = await remoteStreamFixture();
    try {
      const pending = fixture.request();
      await fixture.started;
      fixture.source.error(new Error("Upstream stream failed"));
      const response = await pending;
      expect(response.status).toBe(500);
      expect(response.headers.get("content-type")).toContain(
        "application/json",
      );
      expect(await response.json()).toMatchObject({
        message: "Upstream stream failed",
      });
      await fixture.forwarded();
      expect(fixture.rootHandler).not.toHaveBeenCalled();
    } finally {
      await fixture.close();
    }
  });
});

describe("proxiedGuestUrl", () => {
  it("routes a server app's document through the desktop proxy", () => {
    expect(
      proxiedGuestUrl({
        state: {
          state: "ready",
          guestUrl:
            "https://brain.example.com/api/projects/remote-1/apps/pilot/guest?channel=dev&versionId=v1",
        },
        localBase:
          "http://127.0.0.1:4000/desktop/projects/local-1/remote-api/api",
        remoteProjectId: "remote-1",
        localProjectId: "local-1",
      }),
    ).toEqual({
      state: "ready",
      guestUrl:
        "http://127.0.0.1:4000/desktop/projects/local-1/remote-api/api/projects/local-1/apps/pilot/guest?channel=dev&versionId=v1",
    });
    expect(
      proxiedGuestUrl({
        state: { state: "not_published" },
        localBase: "x",
        remoteProjectId: "r",
        localProjectId: "l",
      }),
    ).toEqual({ state: "not_published" });
  });
});
