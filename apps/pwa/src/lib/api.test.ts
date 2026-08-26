import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const realCrypto = globalThis.crypto;

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

afterEach(() => {
  vi.stubGlobal("crypto", realCrypto);
  vi.restoreAllMocks();
});

describe("PWA authenticated fetch", () => {
  it("refreshes an expired remote credential before the request", async () => {
    const store = await import("./store.js");
    const { authenticatedFetch } = await import("./api.js");
    const profile = store.activeProfile(store.getState());
    const connection = store.addRemoteConnection({
      profileId: profile.id,
      link: {
        serverUrl: "https://brain.acme.dev/api",
        remoteProjectId: "project-1",
      },
      credentials: {
        clientId: "pwa-client",
        accessToken: "expired-access",
        refreshToken: "refresh-1",
        accessTokenExpiresAt: "2026-08-26T11:00:00.000Z",
        tokenEndpoint: "https://brain.acme.dev/api/auth/mcp/token",
        scope: "openid offline_access",
      },
    });
    const requests: Request[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      if (new URL(request.url).pathname.endsWith("/token")) {
        return Response.json({
          access_token: "fresh-access",
          refresh_token: "refresh-2",
          expires_in: 3600,
          scope: "openid offline_access",
        });
      }
      return Response.json({ ok: true });
    };

    const response = await authenticatedFetch({
      connectionId: connection.id,
      fetch: fetchImpl,
      now: () => Date.parse("2026-08-26T12:00:00.000Z"),
    })("https://brain.acme.dev/api/me");

    expect(response.status).toBe(200);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.headers.get("authorization")).toBe(
      "Bearer fresh-access",
    );
    expect(store.connectionById(store.getState(), connection.id)).toMatchObject(
      {
        credentials: {
          accessToken: "fresh-access",
          refreshToken: "refresh-2",
        },
      },
    );
  });

  it("refreshes and retries once after an invalid-token response", async () => {
    const store = await import("./store.js");
    const { authenticatedFetch } = await import("./api.js");
    const profile = store.activeProfile(store.getState());
    const connection = store.addRemoteConnection({
      profileId: profile.id,
      link: {
        serverUrl: "https://brain.acme.dev/api",
        remoteProjectId: "project-1",
      },
      credentials: {
        clientId: "pwa-client",
        accessToken: "stale-access",
        refreshToken: "refresh-1",
        accessTokenExpiresAt: "2026-08-26T13:00:00.000Z",
        tokenEndpoint: "https://brain.acme.dev/api/auth/mcp/token",
        scope: "openid offline_access",
      },
    });
    let resourceRequests = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname.endsWith("/token")) {
        return Response.json({
          access_token: "fresh-access",
          refresh_token: "refresh-2",
          expires_in: 3600,
        });
      }
      resourceRequests += 1;
      return resourceRequests === 1
        ? new Response(null, { status: 401 })
        : Response.json({ ok: true });
    };

    const response = await authenticatedFetch({
      connectionId: connection.id,
      fetch: fetchImpl,
      now: () => Date.parse("2026-08-26T12:00:00.000Z"),
    })("https://brain.acme.dev/api/me");

    expect(response.status).toBe(200);
    expect(resourceRequests).toBe(2);
  });

  it("uses a paired desktop device token without OAuth refresh", async () => {
    const store = await import("./store.js");
    const { authenticatedFetch } = await import("./api.js");
    const profile = store.activeProfile(store.getState());
    const connection = store.addDeviceConnection({
      profileId: profile.id,
      serverUrl: "http://192.168.1.71:4756/api",
      name: "Desktop",
      accessToken: "device-token",
    });
    let authorization = "";
    const fetchImpl: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      authorization = request.headers.get("authorization") ?? "";
      return Response.json({ ok: true });
    };

    await authenticatedFetch({
      connectionId: connection.id,
      fetch: fetchImpl,
    })("http://192.168.1.71:4756/api/me");

    expect(authorization).toBe("Bearer device-token");
  });

  it("requires sign-in for a remote locator without credentials", async () => {
    const store = await import("./store.js");
    const { authenticatedFetch } = await import("./api.js");
    const profile = store.activeProfile(store.getState());
    const connection = store.addRemoteConnection({
      profileId: profile.id,
      link: {
        serverUrl: "https://brain.acme.dev/api",
        remoteProjectId: "project-1",
      },
    });

    await expect(
      authenticatedFetch({ connectionId: connection.id })(
        "https://brain.acme.dev/api/me",
      ),
    ).rejects.toThrow("Sign in to this server");
  });
});
