import { createHash } from "node:crypto";
import http from "node:http";
import {
  HTTP_REQUEST_MAX_BYTES,
  HttpGatewayService,
  type LiveHttpGrant,
} from "@catamorphic/core";
import { afterEach, describe, expect, it } from "vitest";
import { createTestApp } from "./test-app.js";

const GRANT = "grant-token";
const REAL_KEY = "reader:real-password";
const apps: ReturnType<typeof createTestApp>[] = [];
const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

function digest(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const liveGrant = async ({
  token,
}: {
  token: string;
}): Promise<LiveHttpGrant | undefined> =>
  token === GRANT
    ? {
        id: "grant-1",
        tenantId: "tenant-1",
        allocationId: "allocation-1",
        agentSessionId: null,
        alias: "logs",
        channel: "sandbox",
        connection: {
          id: "connection-1",
          revision: 1,
          status: "ready",
          expiresAt: null,
        },
      }
    : undefined;

/** The gateway with a fake broker, in front of `baseUrl`. */
function appWithGateway(input: { baseUrl: string; fetch?: typeof fetch }) {
  const counts = { liveGrant: 0 };
  const httpGateway = new HttpGatewayService({
    store: {
      liveGrant: async (args) => {
        counts.liveGrant++;
        return liveGrant(args);
      },
    },
    broker: {
      httpEndpoint: async () => ({
        endpoint: {
          baseUrl: input.baseUrl,
          headers: () => ({}),
        },
        headers: {
          authorization: `Basic ${Buffer.from(REAL_KEY).toString("base64")}`,
        },
        binding: {
          connectionId: "connection-1",
          alias: "logs",
          providerKind: "logs",
          principalKind: "project_service",
          capabilities: ["get", "post"],
        },
        projectId: "project-1",
        reads: ["get"],
        contained: false,
      }),
      reviewHttpCall: async () => async () => {},
    },
    ...(input.fetch ? { fetch: input.fetch } : {}),
  });
  const app = createTestApp({ core: { httpGateway } as never });
  apps.push(app);
  return { app, counts };
}

/** A fake API that records what reached it. */
function recordingFetch() {
  const calls: Array<{
    url: string;
    method: string;
    authorization: string | null;
    body: string | undefined;
  }> = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const body = init?.body;
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      authorization: new Headers(init?.headers).get("authorization"),
      body: body instanceof Uint8Array ? digest(body) : undefined,
    });
    return new Response("1\n", { headers: { "content-type": "text/plain" } });
  };
  return { calls, fetch };
}

describe("HTTP gateway routes (ADR 0211)", () => {
  it("forwards the alias itself and the raw path below it, with any grant form", async () => {
    const { calls, fetch } = recordingFetch();
    const { app, counts } = appWithGateway({
      baseUrl: "https://logs.example.test:8443",
      fetch,
    });
    // ClickHouse's interface lives at the base: the alias with no slash.
    const root = await app.inject({
      method: "GET",
      url: "/api/gateway/http/logs?query=SELECT%201",
      headers: {
        authorization: `Basic ${Buffer.from(`default:${GRANT}`).toString("base64")}`,
      },
    });
    expect(root.statusCode).toBe(200);
    expect(root.body).toBe("1\n");
    const payload = Buffer.from([0, 1, 2, 250, 251, 252]);
    const posted = await app.inject({
      method: "POST",
      url: "/api/gateway/http/logs/?query=INSERT%20INTO%20t%20FORMAT%20RowBinary",
      headers: {
        "x-work-grant": GRANT,
        authorization: "Bearer the-callers-own",
        "content-type": "application/octet-stream",
      },
      payload,
    });
    expect(posted.statusCode).toBe(200);
    const below = await app.inject({
      method: "GET",
      url: "/api/gateway/http/logs/ping/a%40b:c",
      headers: { authorization: `Bearer ${GRANT}` },
    });
    expect(below.statusCode).toBe(200);
    const key = `Basic ${Buffer.from(REAL_KEY).toString("base64")}`;
    expect(calls).toEqual([
      {
        url: "https://logs.example.test:8443?query=SELECT%201",
        method: "GET",
        authorization: key,
        body: undefined,
      },
      {
        url: "https://logs.example.test:8443/?query=INSERT%20INTO%20t%20FORMAT%20RowBinary",
        method: "POST",
        authorization: key,
        body: digest(payload),
      },
      {
        url: "https://logs.example.test:8443/ping/a%40b:c",
        method: "GET",
        authorization: key,
        body: undefined,
      },
    ]);
    // The admission from before the body is the handler's: one check each.
    expect(counts.liveGrant).toBe(3);
  });

  it("refuses a missing grant before the body, and a path leaving the base", async () => {
    const { calls, fetch } = recordingFetch();
    const { app } = appWithGateway({
      baseUrl: "https://logs.example.test",
      fetch,
    });
    const refused = await app.inject({
      method: "POST",
      url: "/api/gateway/http/logs/",
      headers: { "content-type": "text/plain" },
      payload: "SELECT 1",
    });
    expect(refused.statusCode).toBe(401);
    expect(refused.headers.connection).toBe("close");
    expect(refused.headers["www-authenticate"]).toContain("Basic");
    expect(refused.json()).toMatchObject({ error: { status: 401 } });
    const escaped = await app.inject({
      method: "GET",
      // Encoded slashes: the injector, like any client, resolves dot
      // segments before they are sent; the core tests send them raw.
      url: "/api/gateway/http/logs/a%2F..%2F..%2Fadmin",
      headers: { authorization: `Bearer ${GRANT}` },
    });
    expect(escaped.statusCode).toBe(404);
    // A body past 32 MiB is refused, not forwarded.
    const large = await app.inject({
      method: "POST",
      url: "/api/gateway/http/logs/",
      headers: {
        authorization: `Bearer ${GRANT}`,
        "content-type": "application/octet-stream",
      },
      payload: Buffer.alloc(HTTP_REQUEST_MAX_BYTES + 1),
    });
    expect(large.statusCode).toBe(413);
    expect(calls).toHaveLength(0);
  });

  it("streams an answer from the API as it arrives", async () => {
    const chunk = Buffer.alloc(256 * 1024, 97);
    const chunks = 64;
    const upstream = http.createServer((request, response) => {
      expect(request.headers.authorization).toBe(
        `Basic ${Buffer.from(REAL_KEY).toString("base64")}`,
      );
      response.writeHead(200, { "content-type": "application/octet-stream" });
      let sent = 0;
      const pump = () => {
        while (sent < chunks) {
          sent += 1;
          if (!response.write(chunk)) {
            response.once("drain", pump);
            return;
          }
        }
        response.end();
      };
      pump();
    });
    servers.push(upstream);
    await new Promise<void>((resolve) =>
      upstream.listen(0, "127.0.0.1", resolve),
    );
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("No address");
    const { app } = appWithGateway({
      baseUrl: `http://127.0.0.1:${address.port}`,
    });
    const listening = await app.listen({ port: 0, host: "127.0.0.1" });
    const response = await fetch(`${listening}/api/gateway/http/logs/export`, {
      headers: { authorization: `Bearer ${GRANT}` },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/octet-stream",
    );
    const reader = response.body?.getReader();
    if (!reader) throw new Error("No body");
    let total = 0;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
    }
    expect(total).toBe(chunk.length * chunks);
  }, 60_000);
});
