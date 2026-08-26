import { describe, expect, it, vi } from "vitest";
import { authorizeRemoteServer } from "./remote-oauth.js";

describe("remote server OAuth", () => {
  it("discovers, registers a public client, uses S256 PKCE, and exchanges the callback", async () => {
    let registeredRedirect = "";
    let authorizeURL: URL | undefined;
    const fetchImpl = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(
          typeof input === "string" || input instanceof URL ? input : input.url,
        );
        if (url.pathname === "/.well-known/oauth-protected-resource") {
          return Response.json({
            resource: "https://team.example/api",
            authorization_servers: ["https://team.example"],
          });
        }
        if (url.pathname === "/.well-known/oauth-authorization-server") {
          return Response.json({
            authorization_endpoint:
              "https://team.example/api/auth/mcp/authorize",
            token_endpoint: "https://team.example/api/auth/mcp/token",
            registration_endpoint: "https://team.example/api/auth/mcp/register",
            code_challenge_methods_supported: ["S256"],
          });
        }
        if (url.pathname === "/api/auth/mcp/register") {
          const body = JSON.parse(String(init?.body)) as {
            redirect_uris: string[];
          };
          registeredRedirect = body.redirect_uris[0] ?? "";
          return Response.json(
            { client_id: "desktop-client" },
            { status: 201 },
          );
        }
        if (url.pathname === "/api/auth/mcp/token") {
          const body = new URLSearchParams(String(init?.body));
          expect(body.get("client_id")).toBe("desktop-client");
          expect(body.get("code_verifier")?.length).toBeGreaterThan(40);
          return Response.json({
            access_token: "access-1",
            refresh_token: "refresh-1",
            expires_in: 3600,
            token_type: "Bearer",
            scope: "openid offline_access",
          });
        }
        throw new Error(`Unexpected fetch ${url}`);
      },
    );
    const openExternal = vi.fn(async (url: string) => {
      authorizeURL = new URL(url);
      expect(authorizeURL.searchParams.get("code_challenge_method")).toBe(
        "S256",
      );
      const callback = new URL(registeredRedirect);
      callback.searchParams.set("code", "authorization-code");
      callback.searchParams.set(
        "state",
        authorizeURL.searchParams.get("state") ?? "",
      );
      await fetch(callback);
    });

    const result = await authorizeRemoteServer({
      serverUrl: "https://team.example/api",
      fetch: fetchImpl,
      openExternal,
    });
    expect(result).toMatchObject({
      clientId: "desktop-client",
      accessToken: "access-1",
      refreshToken: "refresh-1",
      tokenEndpoint: "https://team.example/api/auth/mcp/token",
    });
    expect(authorizeURL?.searchParams.get("scope")).toContain("offline_access");
  });
});
