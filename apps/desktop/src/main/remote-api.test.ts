import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString(),
  },
}));

import { forwardRemoteApi } from "./remote-api.js";
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
