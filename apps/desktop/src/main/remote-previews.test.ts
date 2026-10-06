import fs from "node:fs";
import http from "node:http";
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
  previewHost,
  RemotePreviewOrigins,
} from "./remote-previews.js";
import { RemoteProjectsStore } from "./remote-projects-store.js";

const SESSION = "b2c3d4e5-f6a7-4890-bcde-a12345678901";
const PREVIEW = `/api/projects/remote/agent/sessions/${SESSION}/previews/3000`;

interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

interface Answer {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/**
 * A request as a browser tab sends it to a preview: to the loopback port,
 * naming the preview's host (Chromium resolves `*.localhost` itself), or
 * another host when `host` says so.
 */
function send(
  url: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    host?: string;
  } = {},
): Promise<Answer> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: init.method ?? "GET",
        headers: { host: init.host ?? target.host, ...init.headers },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    request.on("error", reject);
    request.end(init.body);
  });
}

describe("previews of a remote chat's workspace (ADR 0209)", () => {
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
        headers: request.headers,
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
  const address = { projectId: "local", sessionId: SESSION, port: 3000 };

  it("gives each preview a host of its own, forwarding as the member", async () => {
    const origins = new RemotePreviewOrigins({
      file: path.join(directory, "previews.json"),
      profiles: profiles(),
    });
    try {
      const url = await origins.open(address);
      expect(url).toMatch(/^http:\/\/p-[0-9a-f]{20}\.localhost:\d+\/$/);
      expect(new URL(url).hostname).toBe(previewHost(address));
      // Another preview, of another chat or port, is another host.
      expect(previewHost({ ...address, port: 3001 })).not.toBe(
        previewHost(address),
      );
      const own = url.slice(0, -1);

      const page = await send(`${url}assets/app.js?v=1`, {
        headers: {
          cookie: "session=abc",
          origin: own,
          "x-work-desktop-token": "this-computer",
          "x-catamorphic-runner": "spoofed",
          "x-forwarded-for": "10.0.0.1",
          authorization: "Bearer page-supplied",
        },
      });
      expect(page.status).toBe(200);
      expect(page.body).toBe("answer to GET");
      expect(page.headers["access-control-allow-origin"]).toBeUndefined();
      const forwarded = seen.at(-1);
      expect(forwarded).toMatchObject({ url: `${PREVIEW}/assets/app.js?v=1` });
      expect(forwarded?.headers).toMatchObject({
        authorization: "Bearer member-token",
        cookie: "session=abc",
        // The page's own origin is the server's own in the sandbox.
        origin: "http://127.0.0.1:3000",
        "x-catamorphic-runner": "runner-id",
      });
      // This computer's credentials and host-internal headers stay here.
      expect(forwarded?.headers["x-work-desktop-token"]).toBeUndefined();
      expect(forwarded?.headers["x-forwarded-for"]).toBeUndefined();

      const posted = await send(`${url}submit`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream", origin: own },
        body: "payload",
      });
      expect(posted.status).toBe(201);
      expect(seen.at(-1)).toMatchObject({ method: "POST", body: "payload" });

      // Another site, in any browser, gets nothing from the preview, nor
      // does a request to the bare loopback address, which shares the
      // person's own cookies.
      const before = seen.length;
      for (const refused of [
        await send(`${url}submit`, {
          method: "POST",
          headers: {
            "content-type": "application/octet-stream",
            origin: "https://elsewhere.example",
            cookie: "session=abc",
          },
          body: "payload",
        }),
        await send(`${url}assets/app.js`, {
          headers: { "sec-fetch-site": "cross-site", cookie: "session=abc" },
        }),
        await send(`${url}assets/app.js`, {
          host: `127.0.0.1:${new URL(url).port}`,
          headers: { cookie: "mine=1" },
        }),
      ])
        expect(refused.status).toBe(403);
      expect(seen.length).toBe(before);

      const redirected = await send(`${url}go`);
      expect(redirected.status).toBe(302);
      expect(redirected.headers.location).toBe("/landing?from=go");
      expect(redirected.headers["set-cookie"]).toEqual([
        "a=1; Path=/",
        "b=2; Path=/; HttpOnly",
      ]);

      const refused = await send(`${url}down`);
      expect(refused.status).toBe(502);
      expect(refused.headers["content-type"]).toContain("text/html");
      expect(refused.body).toContain(
        "Nothing in this chat's workspace answers on port 3000.",
      );
    } finally {
      await origins.close();
    }
  });

  it("keeps a preview's address across restarts", async () => {
    const file = path.join(directory, "previews.json");
    const first = new RemotePreviewOrigins({ file, profiles: profiles() });
    const url = await first.open(address);
    await first.close();

    const second = new RemotePreviewOrigins({ file, profiles: profiles() });
    try {
      await second.restore();
      const page = await send(`${url}again`);
      expect(page.body).toBe("answer to GET");
      expect(await second.open(address)).toBe(url);
    } finally {
      await second.close();
    }
  });

  it("forwards the member's bearer only as the authorization it adds", async () => {
    const answer = await forwardPreview({
      profiles: profiles(),
      address,
      path: "/go",
      method: "GET",
      headers: [
        ["authorization", "Bearer desktop-root"],
        ["X-Work-Desktop-Token", "this-computer"],
      ],
    });
    expect(answer?.status).toBe(302);
    expect(answer?.headers).toContainEqual(["location", "/landing?from=go"]);
    expect(seen.at(-1)?.headers.authorization).toBe("Bearer member-token");
    expect(seen.at(-1)?.headers["x-work-desktop-token"]).toBeUndefined();
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
    expect(localPreviewLocation({ location, sessionId, port: 3000 })).toBe(
      expected,
    );
  });
});
