import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString(),
  },
}));

import {
  forwardPreview,
  localPreviewLocation,
  RemotePreviewOrigins,
} from "./remote-previews.js";
import { RemoteProjectsStore } from "./remote-projects-store.js";

const SESSION = "b2c3d4e5-f6a7-4890-bcde-a12345678901";
const PREVIEW = `/api/projects/remote/agent/sessions/${SESSION}/previews/3000`;

interface Seen {
  method: string;
  url: string;
  authorization?: string;
  origin?: string;
  cookie?: string;
  body: string;
}

describe("previews of a remote chat's workspace (ADR 0208)", () => {
  let directory: string;
  let remote: FastifyInstance;
  let store: RemoteProjectsStore;
  const seen: Seen[] = [];

  beforeEach(async () => {
    seen.length = 0;
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "cat-previews-"));
    remote = Fastify();
    remote.removeAllContentTypeParsers();
    remote.addContentTypeParser(
      "*",
      { parseAs: "buffer" },
      (_request, body, done) => done(null, body),
    );
    remote.all(`${PREVIEW}/*`, async (request, reply) => {
      seen.push({
        method: request.method,
        url: request.url,
        ...(request.headers.authorization
          ? { authorization: request.headers.authorization }
          : {}),
        ...(request.headers.origin ? { origin: request.headers.origin } : {}),
        ...(request.headers.cookie ? { cookie: request.headers.cookie } : {}),
        body: Buffer.isBuffer(request.body) ? request.body.toString() : "",
      });
      if (request.url.endsWith("/go"))
        return reply
          .status(302)
          .header("location", `${PREVIEW}/landing?from=go`)
          .header("set-cookie", ["a=1; Path=/", "b=2; Path=/; HttpOnly"])
          .send();
      if (request.url.endsWith("/down"))
        return reply.status(502).header("x-work-preview-refusal", "1").send({
          error: "Nothing in this chat's workspace answers on port 3000.",
          code: "unreachable",
        });
      return (
        reply
          .status(request.method === "POST" ? 201 : 200)
          .type("text/plain")
          // Dev servers often allow any origin; the preview does not.
          .header("access-control-allow-origin", "*")
          .send(`answer to ${request.method}`)
      );
    });
    const base = await remote.listen({ port: 0, host: "127.0.0.1" });
    store = new RemoteProjectsStore(path.join(directory, "remote.json"));
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
  });

  afterEach(async () => {
    await remote.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const profiles = () => ({ forProject: () => ({ remoteProjects: store }) });

  it("gives each preview its own origin, forwarding as the member", async () => {
    const origins = new RemotePreviewOrigins({
      file: path.join(directory, "previews.json"),
      profiles: profiles(),
    });
    try {
      const url = await origins.open({
        projectId: "local",
        sessionId: SESSION,
        port: 3000,
      });
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
      const own = url.slice(0, -1);

      const page = await fetch(`${url}assets/app.js?v=1`, {
        headers: { cookie: "session=abc", origin: own },
      });
      expect(page.status).toBe(200);
      expect(await page.text()).toBe("answer to GET");
      expect(page.headers.get("access-control-allow-origin")).toBeNull();
      expect(seen.at(-1)).toMatchObject({
        url: `${PREVIEW}/assets/app.js?v=1`,
        authorization: "Bearer member-token",
        cookie: "session=abc",
        // The page's own origin is the server's own in the sandbox.
        origin: "http://127.0.0.1:3000",
      });

      const posted = await fetch(`${url}submit`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream", origin: own },
        body: "payload",
      });
      expect(posted.status).toBe(201);
      expect(seen.at(-1)).toMatchObject({ method: "POST", body: "payload" });

      // Another site, in any browser, gets nothing from the preview.
      const forwarded = seen.length;
      const foreign = await fetch(`${url}submit`, {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          origin: "https://elsewhere.example",
        },
        body: "payload",
      });
      expect(foreign.status).toBe(403);
      const embedded = await fetch(`${url}assets/app.js`, {
        headers: { "sec-fetch-site": "cross-site" },
      });
      expect(embedded.status).toBe(403);
      expect(seen.length).toBe(forwarded);

      const redirected = await fetch(`${url}go`, { redirect: "manual" });
      expect(redirected.status).toBe(302);
      expect(redirected.headers.get("location")).toBe("/landing?from=go");
      expect(redirected.headers.getSetCookie()).toEqual([
        "a=1; Path=/",
        "b=2; Path=/; HttpOnly",
      ]);

      const refused = await fetch(`${url}down`);
      expect(refused.status).toBe(502);
      expect(refused.headers.get("content-type")).toContain("text/html");
      expect(await refused.text()).toContain(
        "Nothing in this chat's workspace answers on port 3000.",
      );
    } finally {
      await origins.close();
    }
  });

  it("keeps a preview's address across restarts", async () => {
    const file = path.join(directory, "previews.json");
    const address = { projectId: "local", sessionId: SESSION, port: 3000 };
    const first = new RemotePreviewOrigins({ file, profiles: profiles() });
    const url = await first.open(address);
    await first.close();

    const second = new RemotePreviewOrigins({ file, profiles: profiles() });
    try {
      await second.restore();
      const page = await fetch(`${url}again`);
      expect(await page.text()).toBe("answer to GET");
      expect(await second.open(address)).toBe(url);
    } finally {
      await second.close();
    }
  });

  it("keeps redirects below a path-based proxy's prefix", async () => {
    const local = `/desktop/projects/local/remote-api/api/projects/local/agent/sessions/${SESSION}/previews/3000`;
    const answer = await forwardPreview({
      profiles: profiles(),
      address: { projectId: "local", sessionId: SESSION, port: 3000 },
      path: "/go",
      method: "GET",
      headers: [["authorization", "Bearer desktop-root"]],
      localPrefix: local,
    });
    expect(answer?.status).toBe(302);
    expect(answer?.headers).toContainEqual([
      "location",
      `${local}/landing?from=go`,
    ]);
    // The desktop's own credential never travels; the member's does.
    expect(seen.at(-1)?.authorization).toBe("Bearer member-token");
  });
});

describe("localPreviewLocation", () => {
  const sessionId = "s";
  it.each([
    [
      "https://brain.example.com/api/projects/r/agent/sessions/s/previews/3000/a?b=1",
      "/a?b=1",
    ],
    ["/api/projects/r/agent/sessions/s/previews/3000", "/"],
    ["https://github.com/login", "https://github.com/login"],
    [
      "/api/projects/r/agent/sessions/s/previews/4000/x",
      "/api/projects/r/agent/sessions/s/previews/4000/x",
    ],
  ])("%s", (location, expected) => {
    expect(
      localPreviewLocation({
        location,
        sessionId,
        port: 3000,
        localPrefix: "",
      }),
    ).toBe(expected);
  });
});
