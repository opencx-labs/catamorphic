import {
  type CatamorphicCore,
  WebhookMethodNotAllowedError,
  WebhookNotFoundError,
  WebhookRejectedError,
  WebhookTooLargeError,
} from "@catamorphic/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestApp } from "./test-app.js";

const PROJECT_ID = "a1b2c3d4-e5f6-4890-abcd-ef1234567890";
const apps: ReturnType<typeof createTestApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("webhook routes", () => {
  it("hands the exact bytes, headers and query to receive, signed in or not", async () => {
    const receive = vi.fn(async () => ({
      type: "event",
      eventId: "event-1",
      duplicate: false,
    }));
    // Senders have no account: a failing identity lookup never blocks them.
    const identity = vi.fn(() => {
      throw new Error("not signed in");
    });
    const app = createTestApp({
      core: { webhooks: { receive } } as unknown as CatamorphicCore,
      identity,
    });
    apps.push(app);
    const body = '{"a": 1,  "b":2}';
    const response = await app.inject({
      method: "POST",
      url: `/api/hooks/${PROJECT_ID}/github/token-1?source=ci&tag=a&tag=b`,
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": "sha256=x",
      },
      payload: body,
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ id: "event-1", duplicate: false });
    const [call] = receive.mock.calls as unknown as Array<
      [
        {
          body: Buffer;
          headers: Record<string, string>;
          query: Record<string, string>;
          method: string;
          name: string;
          token: string;
        },
      ]
    >;
    expect(call?.[0].body.toString("utf8")).toBe(body);
    expect(call?.[0]).toMatchObject({
      projectId: PROJECT_ID,
      name: "github",
      token: "token-1",
      method: "POST",
      query: { source: "ci", tag: "a" },
      headers: { "x-hub-signature-256": "sha256=x" },
    });
  });

  it("answers a handshake with its value as text, on GET or POST", async () => {
    const receive = vi.fn(async () => ({
      type: "handshake",
      answer: "1158201444",
    }));
    const app = createTestApp({
      core: { webhooks: { receive } } as unknown as CatamorphicCore,
    });
    apps.push(app);
    const response = await app.inject({
      method: "GET",
      url: `/api/hooks/${PROJECT_ID}/meta/token-1?hub.mode=subscribe&hub.challenge=1158201444&hub.verify_token=t`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/plain");
    expect(response.body).toBe("1158201444");
    expect(receive.mock.calls[0]).toMatchObject([
      {
        method: "GET",
        query: {
          "hub.mode": "subscribe",
          "hub.challenge": "1158201444",
          "hub.verify_token": "t",
        },
      },
    ]);
  });

  it("maps refusals to 404, 401, 405 and 413", async () => {
    const receive = vi
      .fn()
      .mockRejectedValueOnce(new WebhookNotFoundError())
      .mockRejectedValueOnce(
        new WebhookRejectedError("Signature does not match"),
      )
      .mockRejectedValueOnce(new WebhookMethodNotAllowedError())
      .mockRejectedValueOnce(new WebhookTooLargeError(8));
    const app = createTestApp({
      core: { webhooks: { receive } } as unknown as CatamorphicCore,
    });
    apps.push(app);
    const send = (payload: string, method: "POST" | "GET" = "POST") =>
      app.inject({
        method,
        url: `/api/hooks/${PROJECT_ID}/github/token-1`,
        headers: { "content-type": "text/plain" },
        ...(method === "POST" ? { payload } : {}),
      });
    expect((await send("x")).statusCode).toBe(404);
    const rejected = await send("x");
    expect(rejected.statusCode).toBe(401);
    expect(rejected.json()).toEqual({ error: "Signature does not match" });
    const get = await send("", "GET");
    expect(get.statusCode).toBe(405);
    expect(get.headers.allow).toBe("POST");
    expect((await send("123456789")).statusCode).toBe(413);
    // Beyond the host's maximum the body never reaches the service.
    expect((await send("x".repeat(1024 * 1024 + 1))).statusCode).toBe(413);
    expect(receive).toHaveBeenCalledTimes(4);
  });

  it("admits bodies up to the host's configured maximum", async () => {
    const receive = vi.fn(async () => ({
      type: "event",
      eventId: "event-2",
      duplicate: false,
    }));
    const app = createTestApp({
      core: {
        webhooks: { receive, maxBodyBytes: 2 * 1024 * 1024 },
      } as unknown as CatamorphicCore,
    });
    apps.push(app);
    const response = await app.inject({
      method: "POST",
      url: `/api/hooks/${PROJECT_ID}/big/token-1`,
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.alloc(1024 * 1024 + 1),
    });
    expect(response.statusCode).toBe(202);
  });

  it("lists URLs on the configured public base", async () => {
    const list = vi.fn(async () => [
      {
        name: "github",
        path: `/hooks/${PROJECT_ID}/github/token-1`,
        workflows: ["reviewPullRequest"],
        listening: true,
        verified: true,
      },
    ]);
    const app = createTestApp({
      core: { webhooks: { list } } as unknown as CatamorphicCore,
      publicApiBase: "https://brain.example.com/api/",
    });
    apps.push(app);
    const response = await app.inject({
      method: "GET",
      url: `/api/projects/${PROJECT_ID}/webhooks`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      {
        name: "github",
        url: `https://brain.example.com/api/hooks/${PROJECT_ID}/github/token-1`,
        workflows: ["reviewPullRequest"],
        listening: true,
        verified: true,
      },
    ]);
  });
});
