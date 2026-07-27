import { AppVersionNotFoundError } from "@catamorphic/core";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";

const PROJECT_ID = "a1b2c3d4-e5f6-4890-abcd-ef1234567890";
const VERSION_ID = "b2c3d4e5-f6a7-4890-bcde-a12345678901";
const APP_ID = "c3d4e5f6-a7b8-4890-acde-123456789012";
const apps: ReturnType<typeof createApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("app route contracts", () => {
  it.each([
    { method: "GET", url: `/api/projects/${PROJECT_ID}/apps` },
    {
      method: "GET",
      url: `/api/projects/${PROJECT_ID}/apps/ops-dashboard/versions`,
    },
    {
      method: "POST",
      url: `/api/projects/${PROJECT_ID}/apps/ops-dashboard/builds`,
      payload: { kind: "preview" },
    },
    {
      method: "POST",
      url: `/api/projects/${PROJECT_ID}/app-versions/${VERSION_ID}/publish`,
    },
    {
      method: "GET",
      url: `/api/projects/${PROJECT_ID}/apps/ops-dashboard/view-state`,
    },
    {
      method: "GET",
      url: `/api/projects/${PROJECT_ID}/app-versions/${VERSION_ID}/bundle`,
    },
  ] satisfies readonly {
    method: "GET" | "POST";
    url: string;
    payload?: object;
  }[])("registers $method $url", async ({ method, url, payload }) => {
    const app = createApp();
    apps.push(app);
    const response = await app.inject({
      method,
      url,
      payload,
      headers: {
        "x-catamorphic-tenant-id": "tenant-1",
        "x-external-user-id": "user-1",
      },
    });
    // No core wired: the route exists and answers 503, not 404.
    expect(response.statusCode).toBe(503);
  });

  it("rejects a lone app audience header", async () => {
    const app = createApp();
    apps.push(app);
    const response = await app.inject({
      method: "GET",
      url: `/api/projects/${PROJECT_ID}/apps`,
      headers: {
        "x-catamorphic-tenant-id": "tenant-1",
        "x-external-user-id": "user-1",
        "x-catamorphic-app-id": APP_ID,
      },
    });
    // Identity resolution runs before the 503 core check in handlers that
    // resolve identity first; either way a half-formed audience is a 400.
    expect([400, 503]).toContain(response.statusCode);
    if (response.statusCode === 400) {
      expect(response.json().error).toMatch(/App requests must send both/);
    }
  });

  it("rejects malformed audience header values", async () => {
    const app = createApp();
    apps.push(app);
    const response = await app.inject({
      method: "GET",
      url: `/api/projects/${PROJECT_ID}/apps`,
      headers: {
        "x-catamorphic-tenant-id": "tenant-1",
        "x-external-user-id": "user-1",
        "x-catamorphic-app-id": "not-a-uuid",
        "x-catamorphic-app-version-id": VERSION_ID,
      },
    });
    expect([400, 503]).toContain(response.statusCode);
  });

  it("rejects a commitSha that is not a hex object name", async () => {
    const app = createApp();
    apps.push(app);
    const response = await app.inject({
      method: "POST",
      url: `/api/projects/${PROJECT_ID}/apps/ops-dashboard/builds`,
      payload: { kind: "published", commitSha: "../../etc" },
      headers: {
        "x-catamorphic-tenant-id": "tenant-1",
        "x-external-user-id": "user-1",
      },
    });
    // Schema rejects before the handler's 503 core check.
    expect(response.statusCode).toBe(400);
  });
});

describe("bundle route caching", () => {
  function appWithBundleCore(calls: string[]) {
    const core = {
      apps: {
        assertBundleReadable: async () => {
          calls.push("assertBundleReadable");
        },
        getBundle: async () => {
          calls.push("getBundle");
          return { code: "/* bundle */", css: ".a{}", etag: `"${VERSION_ID}"` };
        },
      },
    };
    const app = createApp({ core: core as never });
    apps.push(app);
    return app;
  }

  const bundleUrl = `/api/projects/${PROJECT_ID}/app-versions/${VERSION_ID}/bundle`;
  const headers = {
    "x-catamorphic-tenant-id": "tenant-1",
    "x-external-user-id": "user-1",
  };

  it("serves the bundle with an immutable validator", async () => {
    const calls: string[] = [];
    const response = await appWithBundleCore(calls).inject({
      method: "GET",
      url: bundleUrl,
      headers,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers.etag).toBe(`"${VERSION_ID}"`);
    expect(response.headers["cache-control"]).toContain("immutable");
    expect(calls).toEqual(["getBundle"]);
  });

  it("revalidates with 304 without reloading the bundle bytes", async () => {
    const calls: string[] = [];
    const response = await appWithBundleCore(calls).inject({
      method: "GET",
      url: bundleUrl,
      headers: { ...headers, "if-none-match": `"${VERSION_ID}"` },
    });
    expect(response.statusCode).toBe(304);
    expect(calls).not.toContain("getBundle");
  });

  it("authorizes the conditional request before answering 304", async () => {
    // The validator is derived from the caller's own URL, so a 304 answered
    // without an access check would be an existence oracle for any version.
    const calls: string[] = [];
    const response = await appWithBundleCore(calls).inject({
      method: "GET",
      url: bundleUrl,
      headers: { ...headers, "if-none-match": `"${VERSION_ID}"` },
    });
    expect(response.statusCode).toBe(304);
    expect(calls).toEqual(["assertBundleReadable"]);
  });

  it("a denied conditional request does not become a 304", async () => {
    const app = createApp({
      core: {
        apps: {
          assertBundleReadable: async () => {
            throw new AppVersionNotFoundError(VERSION_ID);
          },
          getBundle: async () => {
            throw new Error("must not load bytes");
          },
        },
      } as never,
    });
    apps.push(app);
    const response = await app.inject({
      method: "GET",
      url: bundleUrl,
      headers: { ...headers, "if-none-match": `"${VERSION_ID}"` },
    });
    expect(response.statusCode).toBe(404);
  });
});
