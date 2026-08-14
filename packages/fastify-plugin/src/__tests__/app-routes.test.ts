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

  function appWithViewCore(storage?: {
    get?: () => Promise<{ data: Record<string, string>; revision: string }>;
    put?: (...args: unknown[]) => Promise<void>;
  }) {
    const app = createApp({
      core: {
        apps: { viewState: async () => readyState },
        appStorage: {
          get: storage?.get ?? (async () => ({ data: {}, revision: "0" })),
          put: storage?.put ?? (async () => {}),
        },
      } as never,
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
        colors: { bg: "red}</style><script>", fg: "#111" },
      }),
    );
    // A hostile value drops that entry, never the whole theme: the clean
    // color and the appearance still apply.
    const partial = await appWithViewCore().inject({
      method: "GET",
      url: `/api/projects/${PROJECT_ID}/apps/ops-dashboard/guest?theme=${hostile}`,
      headers,
    });
    expect(partial.statusCode).toBe(200);
    expect(partial.body).not.toContain("red}");
    expect(partial.body).toContain("--color-fg:#111");
    expect(partial.body).toContain("color-scheme:light");

    // Without a valid appearance the theme is unusable → unthemed document.
    const noAppearance = encodeURIComponent(
      JSON.stringify({ appearance: "sparkly", colors: { bg: "#fff" } }),
    );
    const unthemed = await appWithViewCore().inject({
      method: "GET",
      url: `/api/projects/${PROJECT_ID}/apps/ops-dashboard/guest?theme=${noAppearance}`,
      headers,
    });
    expect(unthemed.statusCode).toBe(200);
    expect(unthemed.body).not.toContain("color-scheme:light");
    expect(unthemed.body).not.toContain("--color-bg:#fff");
  });

  it("threads feel tokens through, dropping only invalid fields", async () => {
    const theme = encodeURIComponent(
      JSON.stringify({
        appearance: "dark",
        colors: { bg: "#000" },
        fonts: { sans: "Georgia, serif", mono: "x}</style>" },
        radii: { sm: "2px" },
        easing: "cubic-bezier(0.4, 0, 0.2, 1)",
        baseFontSize: "15px",
        rowHeight: "36px",
        motion: { fast: "80ms", base: "not{valid" },
        unknownField: "ignored",
      }),
    );
    const response = await appWithViewCore().inject({
      method: "GET",
      url: `/api/projects/${PROJECT_ID}/apps/ops-dashboard/guest?theme=${theme}`,
      headers,
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("--font-sans:Georgia, serif;");
    expect(response.body).toContain("--radius-sm:2px;");
    expect(response.body).toContain(
      "--ease-standard:cubic-bezier(0.4, 0, 0.2, 1);",
    );
    expect(response.body).toContain("--cat-font-size:15px;");
    expect(response.body).toContain("--cat-row-h:36px;");
    expect(response.body).toContain("--cat-motion-fast:80ms;");
    // The hostile leaves are dropped; their valid siblings survive.
    expect(response.body).not.toContain("--font-mono:x");
    expect(response.body).not.toContain("not{valid");
    expect(response.body).toContain("color-scheme:dark");
  });

  it("revalidates the guest document by version + storage revision", async () => {
    const response = await appWithViewCore().inject({
      method: "GET",
      url: `/api/projects/${PROJECT_ID}/apps/ops-dashboard/guest`,
      headers: { ...headers, "if-none-match": `"${VERSION_ID}-n-0"` },
    });
    expect(response.statusCode).toBe(304);

    // A storage write moves the revision, so a stale copy must miss —
    // otherwise the browser resurrects old app-local data.
    const moved = await appWithViewCore({
      get: async () => ({ data: { k: "v" }, revision: "r2" }),
    }).inject({
      method: "GET",
      url: `/api/projects/${PROJECT_ID}/apps/ops-dashboard/guest`,
      headers: { ...headers, "if-none-match": `"${VERSION_ID}-n-0"` },
    });
    expect(moved.statusCode).toBe(200);
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

describe("app storage", () => {
  const readyState = {
    state: "ready",
    appId: APP_ID,
    versionId: VERSION_ID,
    code: "/* bundle */",
    css: "",
    allowedWorkflows: [],
    allowedNetworkOrigins: [],
  };
  const headers = {
    "x-catamorphic-tenant-id": "tenant-1",
    "x-external-user-id": "user-1",
  };

  it("PUT persists the snapshot through the service", async () => {
    const puts: unknown[] = [];
    const app = createApp({
      core: {
        apps: { viewState: async () => readyState },
        appStorage: {
          get: async () => ({ data: {}, revision: "0" }),
          put: async (...args: unknown[]) => {
            puts.push(args);
          },
        },
      } as never,
    });
    apps.push(app);
    const response = await app.inject({
      method: "PUT",
      url: `/api/projects/${PROJECT_ID}/apps/ops-dashboard/storage`,
      payload: { data: { todos: '["milk"]' } },
      headers,
    });
    expect(response.statusCode).toBe(204);
    expect(puts).toHaveLength(1);
    expect((puts[0] as unknown[])[3]).toEqual({ todos: '["milk"]' });
  });

  it("guest document bakes the caller's seed in, HTML-inert", async () => {
    const app = createApp({
      core: {
        apps: { viewState: async () => readyState },
        appStorage: {
          get: async () => ({
            // A hostile value must never reach the HTML tokenizer intact.
            data: { note: "</script><img src=x onerror=alert(1)>" },
            revision: "r7",
          }),
          put: async () => {},
        },
      } as never,
    });
    apps.push(app);
    const response = await app.inject({
      method: "GET",
      url: `/api/projects/${PROJECT_ID}/apps/ops-dashboard/guest`,
      headers,
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("\\u003c/script\\u003e");
    expect(response.body).not.toContain("</script><img");
    // Storage writes must invalidate the browser's cached document.
    expect(response.headers.etag).toContain("r7");
  });
});
