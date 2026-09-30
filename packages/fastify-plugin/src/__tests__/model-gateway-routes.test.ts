import { createHash } from "node:crypto";
import { ModelGatewayService } from "@catamorphic/core";
import { afterEach, describe, expect, it } from "vitest";
import { createTestApp } from "./test-app.js";

const GRANT = "grant-token";
const apps: ReturnType<typeof createTestApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function digest(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function appWithGateway() {
  const calls: Array<{
    url: string;
    method: string;
    key: string | null;
    body: string | undefined;
  }> = [];
  const counts = { liveGrant: 0 };
  const modelGateway = new ModelGatewayService({
    store: {
      liveGrant: async ({ token }) => {
        counts.liveGrant++;
        return token === GRANT
          ? {
              id: "grant-1",
              tenantId: "tenant-1",
              allocationId: "allocation-1",
              agentSessionId: null,
              alias: "anthropic",
              connection: {
                id: "connection-1",
                revision: 1,
                status: "ready",
                expiresAt: null,
              },
            }
          : undefined;
      },
      runningTurn: async () => undefined,
      openUsage: async () => "1",
      recordUsage: async () => {},
      openCalls: async () => 0,
      usage: async () => undefined,
    },
    broker: {
      reviews: () => false,
      modelEndpoint: async () => ({
        endpoint: {
          api: "anthropic",
          baseUrl: "https://api.anthropic.test",
          headers: () => ({ "x-api-key": "sk-real" }),
        },
        headers: { "x-api-key": "sk-real" },
        binding: {
          connectionId: "connection-1",
          alias: "anthropic",
          providerKind: "anthropic",
          principalKind: "tenant_service",
          capabilities: ["model"],
        },
        projectId: "project-1",
      }),
      reviewModelCall: async () => async () => {},
    },
    fetch: async (input, init) => {
      const body = init?.body;
      calls.push({
        url: String(input),
        method: init?.method ?? "GET",
        key: new Headers(init?.headers).get("x-api-key"),
        body: body instanceof Uint8Array ? digest(body) : undefined,
      });
      return new Response('data: {"type":"ping"}\n\n', {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  const app = createTestApp({ core: { modelGateway } as never });
  apps.push(app);
  return { app, calls, counts };
}

describe("model gateway routes", () => {
  it("forwards any method and the raw path below the alias", async () => {
    const { app, calls, counts } = appWithGateway();
    const read = await app.inject({
      method: "GET",
      url: "/api/gateway/model/anthropic/v1/models/claude%40x:latest?beta=true",
      headers: { "x-api-key": GRANT },
    });
    expect(read.statusCode).toBe(200);
    expect(read.body).toBe('data: {"type":"ping"}\n\n');
    const payload = Buffer.from([0, 1, 2, 250, 251, 252]);
    const removed = await app.inject({
      method: "DELETE",
      url: "/api/gateway/model/anthropic/v1/files/file_1",
      headers: {
        "x-api-key": GRANT,
        "content-type": "application/octet-stream",
      },
      payload,
    });
    expect(removed.statusCode).toBe(200);
    expect(calls).toEqual([
      {
        url: "https://api.anthropic.test/v1/models/claude%40x:latest?beta=true",
        method: "GET",
        key: "sk-real",
        body: undefined,
      },
      {
        url: "https://api.anthropic.test/v1/files/file_1",
        method: "DELETE",
        key: "sk-real",
        body: digest(payload),
      },
    ]);
    // The admission from before the body is the handler's: one check each.
    expect(counts.liveGrant).toBe(2);
  });

  it("refuses a missing grant before the body and a path leaving the base", async () => {
    const { app, calls } = appWithGateway();
    const refused = await app.inject({
      method: "POST",
      url: "/api/gateway/model/anthropic/v1/messages",
      headers: { "content-type": "application/json" },
      payload: "{}",
    });
    expect(refused.statusCode).toBe(401);
    expect(refused.headers.connection).toBe("close");
    const escaped = await app.inject({
      method: "GET",
      url: "/api/gateway/model/anthropic/v1/a%2F..%2F..%2Fadmin",
      headers: { "x-api-key": GRANT },
    });
    expect(escaped.statusCode).toBe(404);
    expect(escaped.json()).toMatchObject({
      type: "error",
      error: { type: "not_found_error" },
    });
    expect(calls).toHaveLength(0);
  });
});
