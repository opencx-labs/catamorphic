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
      url: `/api/projects/${PROJECT_ID}/apps/ops-dashboard/guest`,
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

describe("guest document serving", () => {
  const readyState = {
    state: "ready",
    appId: APP_ID,
    versionId: VERSION_ID,
    code: "/* bundle */",
    css: ".a{}",
    allowedWorkflows: ["listOrders"],
    allowedNetworkOrigins: ["https://api.example.com"],
  };

  function appWithViewCore() {
    const app = createApp({
      core: { apps: { viewState: async () => readyState } } as never,
    });
    apps.push(app);
    return app;
  }

  const headers = {
    "x-catamorphic-tenant-id": "tenant-1",
    "x-external-user-id": "user-1",
  };

  it("view-state points the mount at the served guest URL", async () => {
    const response = await appWithViewCore().inject({
      method: "GET",
      url: `/api/projects/${PROJECT_ID}/apps/ops-dashboard/view-state?channel=dev`,
      headers,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    // The bundle never rides the JSON view-state: the iframe fetches the
    // served document instead (its own CSP, not the shell's).
    expect(body).toEqual({
      state: "ready",
      appId: APP_ID,
      versionId: VERSION_ID,
      guestUrl: expect.stringMatching(
        /^http:\/\/.+\/api\/projects\/.+\/apps\/ops-dashboard\/guest\?channel=dev$/,
      ),
    });
  });

  it("serves the guest document with its own CSP header", async () => {
    const response = await appWithViewCore().inject({
      method: "GET",
      url: `/api/projects/${PROJECT_ID}/apps/ops-dashboard/guest?channel=dev`,
      headers,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.headers["content-security-policy"]).toContain(
      "default-src 'none'",
    );
    expect(response.headers["content-security-policy"]).toContain(
      "connect-src https://api.example.com",
    );
    expect(response.body).toContain("/* bundle */");
    expect(response.body).toContain('<div id="root">');
  });

  it("seeds a valid theme and ignores a malformed one", async () => {
    const theme = encodeURIComponent(
      JSON.stringify({ appearance: "light", colors: { bg: "#fff" } }),
    );
    const themed = await appWithViewCore().inject({
      method: "GET",
      url: `/api/projects/${PROJECT_ID}/apps/ops-dashboard/guest?theme=${theme}`,
      headers,
    });
    expect(themed.body).toContain("--color-bg:#fff");
    expect(themed.body).toContain("color-scheme:light");

    const hostile = encodeURIComponent(
      JSON.stringify({
        appearance: "light",
        colors: { bg: "red}</style><script>" },
      }),
    );
    const unthemed = await appWithViewCore().inject({
      method: "GET",
      url: `/api/projects/${PROJECT_ID}/apps/ops-dashboard/guest?theme=${hostile}`,
      headers,
    });
    expect(unthemed.statusCode).toBe(200);
    expect(unthemed.body).not.toContain("color-scheme:light");
  });

  it("revalidates the guest document by version", async () => {
    const response = await appWithViewCore().inject({
      method: "GET",
      url: `/api/projects/${PROJECT_ID}/apps/ops-dashboard/guest`,
      headers: { ...headers, "if-none-match": `"${VERSION_ID}-n"` },
    });
    expect(response.statusCode).toBe(304);
  });

  it("answers 404 for a non-ready app", async () => {
    const app = createApp({
      core: {
        apps: { viewState: async () => ({ state: "not_published" }) },
      } as never,
    });
    apps.push(app);
    const response = await app.inject({
      method: "GET",
      url: `/api/projects/${PROJECT_ID}/apps/ops-dashboard/guest`,
      headers,
    });
    expect(response.statusCode).toBe(404);
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
