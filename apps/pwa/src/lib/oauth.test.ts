import { sha256 } from "@noble/hashes/sha2.js";
import { beforeEach, describe, expect, it } from "vitest";
import type { ConnectLink } from "./connect-link.js";
import {
  beginRemoteAuthorization,
  beginServerAuthorization,
  completeRemoteAuthorization,
} from "./oauth.js";

const link: ConnectLink = {
  serverUrl: "https://brain.acme.dev/api",
  remoteProjectId: "project-1",
  remoteProjectName: "Acme Brain",
  invitationId: "invite-1",
  sessionId: "session-1",
};

beforeEach(() => {
  sessionStorage.clear();
});

function oauthFetch(requests: Request[]): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    const url = new URL(request.url);
    if (url.pathname === "/.well-known/oauth-protected-resource") {
      return Response.json({
        resource: "https://brain.acme.dev/api",
        authorization_servers: ["https://brain.acme.dev"],
      });
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return Response.json({
        authorization_endpoint: "https://brain.acme.dev/api/auth/mcp/authorize",
        token_endpoint: "https://brain.acme.dev/api/auth/mcp/token",
        registration_endpoint: "https://brain.acme.dev/api/auth/mcp/register",
        code_challenge_methods_supported: ["S256"],
      });
    }
    if (url.pathname === "/api/auth/mcp/register") {
      return Response.json({ client_id: "pwa-client" }, { status: 201 });
    }
    if (url.pathname === "/api/auth/mcp/token") {
      return Response.json({
        access_token: "access-token",
        refresh_token: "refresh-token",
        expires_in: 3600,
        scope: "openid profile email offline_access",
      });
    }
    return new Response(null, { status: 404 });
  };
}

describe("PWA remote OAuth", () => {
  it("rejects cleartext non-loopback servers before discovery", async () => {
    const requests: Request[] = [];
    await expect(
      beginServerAuthorization({
        serverUrl: "http://brain.acme.test/api",
        redirectUri: "https://app.example/oauth/callback",
        storage: sessionStorage,
        fetch: oauthFetch(requests),
      }),
    ).rejects.toThrow("HTTPS");
    expect(requests).toEqual([]);
  });

  it("rejects a protected resource that delegates authorization to another origin", async () => {
    const requests: Request[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      return Response.json({
        resource: "https://malicious.example/api",
        authorization_servers: ["https://brain.acme.dev"],
      });
    };

    await expect(
      beginServerAuthorization({
        serverUrl: "https://malicious.example/api",
        redirectUri: "https://app.example/oauth/callback",
        storage: sessionStorage,
        fetch: fetchImpl,
      }),
    ).rejects.toThrow("same origin");
    expect(requests).toHaveLength(1);
  });

  it("rejects protected-resource metadata for a different resource", async () => {
    await expect(
      beginServerAuthorization({
        serverUrl: "https://brain.acme.dev/api",
        redirectUri: "https://app.example/oauth/callback",
        storage: sessionStorage,
        fetch: async () =>
          Response.json({
            resource: "https://brain.acme.dev/api/another-project",
            authorization_servers: ["https://brain.acme.dev"],
          }),
      }),
    ).rejects.toThrow("requested resource");
  });

  it("discovers and registers a public S256 PKCE browser client", async () => {
    const requests: Request[] = [];

    const result = await beginRemoteAuthorization({
      link,
      redirectUri: "https://brain.acme.dev/oauth/callback",
      storage: sessionStorage,
      fetch: oauthFetch(requests),
    });

    const authorization = new URL(result.authorizationUrl);
    expect(authorization.origin + authorization.pathname).toBe(
      "https://brain.acme.dev/api/auth/mcp/authorize",
    );
    expect(authorization.searchParams.get("client_id")).toBe("pwa-client");
    expect(authorization.searchParams.get("code_challenge_method")).toBe(
      "S256",
    );
    expect(authorization.searchParams.get("code_challenge")).toBeTruthy();
    expect(authorization.searchParams.get("state")).toBeTruthy();
    const registration = requests.find(
      (request) => new URL(request.url).pathname === "/api/auth/mcp/register",
    );
    expect(await registration?.json()).toMatchObject({
      redirect_uris: ["https://brain.acme.dev/oauth/callback"],
      token_endpoint_auth_method: "none",
    });
  });

  it("records a server-level sign-in without inventing a project", async () => {
    const requests: Request[] = [];
    const started = await beginServerAuthorization({
      serverUrl: "https://brain.acme.dev/api",
      redirectUri: "https://brain.acme.dev/oauth/callback",
      storage: sessionStorage,
      fetch: oauthFetch(requests),
    });
    const state = new URL(started.authorizationUrl).searchParams.get("state");

    const completed = await completeRemoteAuthorization({
      callbackUrl: `https://brain.acme.dev/oauth/callback?code=code-1&state=${state}`,
      storage: sessionStorage,
      fetch: oauthFetch(requests),
    });

    expect(completed.target).toEqual({
      kind: "server",
      serverUrl: "https://brain.acme.dev/api",
    });
  });

  it("validates the callback state and exchanges the code", async () => {
    const requests: Request[] = [];
    const fetchImpl = oauthFetch(requests);
    const started = await beginRemoteAuthorization({
      link,
      redirectUri: "https://brain.acme.dev/oauth/callback",
      storage: sessionStorage,
      fetch: fetchImpl,
    });
    const authorization = new URL(started.authorizationUrl);
    const state = authorization.searchParams.get("state") ?? "";
    const now = Date.parse("2026-08-26T12:00:00.000Z");

    const completed = await completeRemoteAuthorization({
      callbackUrl: `https://brain.acme.dev/oauth/callback?code=code-1&state=${encodeURIComponent(state)}`,
      storage: sessionStorage,
      fetch: fetchImpl,
      now: () => now,
    });

    expect(completed.target).toEqual({ kind: "project", link });
    expect(completed.credentials).toEqual({
      clientId: "pwa-client",
      accessToken: "access-token",
      refreshToken: "refresh-token",
      accessTokenExpiresAt: "2026-08-26T13:00:00.000Z",
      tokenEndpoint: "https://brain.acme.dev/api/auth/mcp/token",
      scope: "openid profile email offline_access",
    });
    const tokenRequest = requests.find(
      (request) => new URL(request.url).pathname === "/api/auth/mcp/token",
    );
    const tokenBody = new URLSearchParams(await tokenRequest?.text());
    expect(tokenBody.get("code")).toBe("code-1");
    expect(tokenBody.get("code_verifier")).toBeTruthy();
    expect(sessionStorage.length).toBe(0);
  });

  it("rejects a callback whose state does not match", async () => {
    const requests: Request[] = [];
    const fetchImpl = oauthFetch(requests);
    await beginRemoteAuthorization({
      link,
      redirectUri: "https://brain.acme.dev/oauth/callback",
      storage: sessionStorage,
      fetch: fetchImpl,
    });

    await expect(
      completeRemoteAuthorization({
        callbackUrl:
          "https://brain.acme.dev/oauth/callback?code=code-1&state=wrong",
        storage: sessionStorage,
        fetch: fetchImpl,
      }),
    ).rejects.toThrow("invalid state");
    expect(
      requests.some(
        (request) => new URL(request.url).pathname === "/api/auth/mcp/token",
      ),
    ).toBe(false);
  });

  it("derives the published code challenge from the private verifier", async () => {
    const result = await beginRemoteAuthorization({
      link,
      redirectUri: "https://brain.acme.dev/oauth/callback",
      storage: sessionStorage,
      fetch: oauthFetch([]),
    });
    const authorization = new URL(result.authorizationUrl);
    const pending = JSON.parse(
      sessionStorage.getItem("catamorphic-pwa.oauth.pending") ?? "{}",
    ) as { verifier?: string };
    const bytes = sha256(new TextEncoder().encode(pending.verifier ?? ""));
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const expected = btoa(binary)
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, "");

    expect(authorization.searchParams.get("code_challenge")).toBe(expected);
  });
});
