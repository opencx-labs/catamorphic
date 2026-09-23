import {
  type CatamorphicCore,
  WebhookNotFoundError,
  WebhookRejectedError,
} from "@catamorphic/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestApp } from "./test-app.js";

const PROJECT_ID = "a1b2c3d4-e5f6-4890-abcd-ef1234567890";
const apps: ReturnType<typeof createTestApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("webhook routes", () => {
  it("hands the exact bytes and headers to ingest, signed in or not", async () => {
    const ingest = vi.fn(async () => ({
      eventId: "event-1",
      duplicate: false,
    }));
    // Senders have no account: a failing identity lookup never blocks them.
    const identity = vi.fn(() => {
      throw new Error("not signed in");
    });
    const app = createTestApp({
      core: { webhooks: { ingest } } as unknown as CatamorphicCore,
      identity,
    });
    apps.push(app);
    const body = '{"a": 1,  "b":2}';
    const response = await app.inject({
      method: "POST",
      url: `/api/hooks/${PROJECT_ID}/github/token-1`,
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": "sha256=x",
      },
      payload: body,
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ id: "event-1", duplicate: false });
    const [call] = ingest.mock.calls as unknown as Array<
      [
        {
          body: Buffer;
          headers: Record<string, string>;
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
      headers: { "x-hub-signature-256": "sha256=x" },
    });
  });

  it("answers 404 for unknown hooks, 401 for bad signatures, 413 for large bodies", async () => {
    const ingest = vi
      .fn()
      .mockRejectedValueOnce(new WebhookNotFoundError())
      .mockRejectedValueOnce(
        new WebhookRejectedError("Signature does not match"),
      );
    const app = createTestApp({
      core: { webhooks: { ingest } } as unknown as CatamorphicCore,
    });
    apps.push(app);
    const send = (payload: string) =>
      app.inject({
        method: "POST",
        url: `/api/hooks/${PROJECT_ID}/github/token-1`,
        headers: { "content-type": "text/plain" },
        payload,
      });
    expect((await send("x")).statusCode).toBe(404);
    const rejected = await send("x");
    expect(rejected.statusCode).toBe(401);
    expect(rejected.json()).toEqual({ error: "Signature does not match" });
    expect((await send("x".repeat(1024 * 1024 + 1))).statusCode).toBe(413);
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
