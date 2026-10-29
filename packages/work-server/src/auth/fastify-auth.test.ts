import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import { request as httpRequest } from "node:http";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { openWorkAuthDatabase } from "./auth-database.js";
import { registerWorkAuthRoutes } from "./fastify-auth.js";
import { createWorkAuth } from "./work-auth.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true });
});

describe("Work server Fastify OAuth bridge", () => {
  it("authorizes and refreshes a public PKCE client", async () => {
    const dataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "cata-fastify-auth-"),
    );
    dirs.push(dataDir);
    const baseURL = "http://127.0.0.1:4700";
    const database = await openWorkAuthDatabase({ dataDir });
    const auth = createWorkAuth({
      database,
      baseURL,
      secret: "fastify-auth-test-secret-with-at-least-32-characters",
    });
    await auth.migrate();
    const user = await auth.createLocalUser({
      username: "grace",
      name: "Grace Hopper",
      password: "correct horse battery staple",
    });
    const app = Fastify();
    registerWorkAuthRoutes(app, {
      auth,
      baseURL,
      methods: { local: true, providers: [] },
    });

    const metadata = await app.inject({
      method: "GET",
      url: "/.well-known/oauth-authorization-server",
    });
    expect(metadata.statusCode).toBe(200);
    expect(metadata.json().issuer).toBe(`${baseURL}/api/auth`);
    const issuerMetadata = await app.inject({
      method: "GET",
      url: "/.well-known/oauth-authorization-server/api/auth",
    });
    expect(issuerMetadata.statusCode).toBe(200);
    expect(issuerMetadata.json()).toEqual(metadata.json());
    const resource = await app.inject({
      method: "GET",
      url: "/.well-known/oauth-protected-resource",
    });
    expect(resource.statusCode).toBe(200);
    const resourcePathMetadata = await app.inject({
      method: "GET",
      url: "/.well-known/oauth-protected-resource/api",
    });
    expect(resourcePathMetadata.statusCode).toBe(200);
    expect(resourcePathMetadata.json()).toEqual(resource.json());
    expect(resource.json()).toMatchObject({
      resource: `${baseURL}/api`,
      authorization_servers: [`${baseURL}/api/auth`],
    });
    expect(metadata.json().code_challenge_methods_supported).toEqual(["S256"]);
    expect(metadata.json()).toMatchObject({
      authorization_endpoint: `${baseURL}/api/auth/oauth2/authorize`,
      registration_endpoint: `${baseURL}/api/auth/oauth2/register`,
      token_endpoint: `${baseURL}/api/auth/oauth2/token`,
    });

    const redirectUri = "http://127.0.0.1:49152/callback";
    const registered = await app.inject({
      method: "POST",
      url: "/api/auth/oauth2/register",
      payload: {
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        client_name: "Work desktop",
      },
    });
    expect(registered.statusCode).toBe(201);
    const clientId = registered.json().client_id as string;
    expect(registered.json().client_secret).toBeUndefined();

    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const authorize = new URL("/api/auth/oauth2/authorize", baseURL);
    authorize.searchParams.set("client_id", clientId);
    authorize.searchParams.set("redirect_uri", redirectUri);
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("scope", "openid profile email offline_access");
    authorize.searchParams.set("state", "state-1");
    authorize.searchParams.set("code_challenge", challenge);
    authorize.searchParams.set("code_challenge_method", "S256");
    authorize.searchParams.set("resource", `${baseURL}/api`);
    const prompted = await app.inject({
      method: "GET",
      url: `${authorize.pathname}${authorize.search}`,
    });
    expect(prompted.statusCode).toBe(302);
    expect(prompted.headers.location).toContain("/login?");
    const loginPage = await app.inject({
      method: "GET",
      url:
        new URL(prompted.headers.location ?? "").pathname +
        new URL(prompted.headers.location ?? "").search,
    });
    expect(loginPage.body).toContain('action="/login/local?');
    expect(loginPage.body).toContain('<html lang="en">');
    expect(loginPage.body).toContain("--accent: #f95225");
    // no-referrer makes Chromium send Origin: null on a native form POST,
    // which correctly fails Better Auth's CSRF check in desktop webviews.
    expect(loginPage.headers["referrer-policy"]).toBe(
      "strict-origin-when-cross-origin",
    );
    expect(loginPage.body).toContain('autocomplete="username"');
    expect(loginPage.body).toContain('autocomplete="current-password"');
    expect(loginPage.body).toContain('id="toggle-password"');
    expect(loginPage.headers["content-security-policy"]).toContain(
      "frame-ancestors 'none'",
    );

    const login = await app.inject({
      method: "POST",
      url: `/login/local${new URL(String(prompted.headers.location), baseURL).search}`,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: new URLSearchParams({
        username: "grace",
        password: "correct horse battery staple",
      }).toString(),
    });
    expect(login.statusCode).toBe(302);
    expect(login.headers.location).toContain("/oauth/consent?");
    const cookie = login.headers["set-cookie"];
    expect(cookie).toBeTruthy();

    const sessionCookie = String(Array.isArray(cookie) ? cookie[0] : cookie);
    const consentURL = new URL(String(login.headers.location), baseURL);
    expect(consentURL.searchParams.get("resource")).toBe(`${baseURL}/api`);
    const consent = await app.inject({
      method: "GET",
      url: `${consentURL.pathname}${consentURL.search}`,
      headers: { cookie: sessionCookie },
    });
    expect(consent.statusCode).toBe(200);
    expect(consent.body).toContain("Allow this connection?");
    expect(consent.body).toContain(clientId);
    expect(consent.body).toContain("offline access");
    expect(consent.body).toContain("Allow access");
    expect(consent.body).toContain('name="oauth_query"');
    expect(consent.body).toContain(
      "resource=http%3A%2F%2F127.0.0.1%3A4700%2Fapi",
    );

    for (const { field, value } of [
      { field: "client_id", value: "untrusted-client" },
      { field: "scope", value: "openid offline_access admin" },
      { field: "resource", value: "https://untrusted.test/api" },
    ]) {
      const tampered = new URL(consentURL);
      tampered.searchParams.set(field, value);
      const shown = await app.inject({
        method: "GET",
        url: `${tampered.pathname}${tampered.search}`,
        headers: { cookie: sessionCookie },
      });
      expect(shown.statusCode).toBe(400);
      expect(shown.body).not.toContain("Allow this connection?");
      const submitted = await app.inject({
        method: "POST",
        url: "/oauth/consent",
        headers: {
          cookie: sessionCookie,
          "content-type": "application/x-www-form-urlencoded",
        },
        payload: new URLSearchParams({
          accept: "true",
          oauth_query: tampered.search.slice(1),
        }).toString(),
      });
      expect(submitted.statusCode).toBe(400);
      expect(submitted.headers.location).toBeUndefined();
    }
    const unsigned = await app.inject({
      method: "GET",
      url: "/oauth/consent?client_id=untrusted-client&scope=openid",
    });
    expect(unsigned.statusCode).toBe(400);

    const decision = (accept: boolean) =>
      app.inject({
        method: "POST",
        url: "/oauth/consent",
        headers: {
          cookie: sessionCookie,
          "content-type": "application/x-www-form-urlencoded",
        },
        payload: new URLSearchParams({
          accept: String(accept),
          oauth_query: consentURL.search.slice(1),
        }).toString(),
      });
    const denied = await decision(false);
    expect(denied.statusCode).toBe(302);
    const deniedCallback = new URL(String(denied.headers.location));
    expect(deniedCallback.searchParams.get("error")).toBe("access_denied");
    expect(deniedCallback.searchParams.get("state")).toBe("state-1");

    const accepted = await decision(true);
    expect(accepted.statusCode).toBe(302);
    const callback = new URL(String(accepted.headers.location));
    expect(callback.searchParams.get("state")).toBe("state-1");
    const code = callback.searchParams.get("code");
    expect(code).toBeTruthy();

    const token = await app.inject({
      method: "POST",
      url: "/api/auth/oauth2/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        redirect_uri: redirectUri,
        code: code ?? "",
        code_verifier: verifier,
      }).toString(),
    });
    expect(token.statusCode).toBe(200);
    const credentials = token.json() as {
      access_token: string;
      refresh_token: string;
    };
    expect(
      await auth.resolveAccessToken({
        authorization: `Bearer ${credentials.access_token}`,
      }),
    ).toMatchObject({
      userId: user.id,
      email: "grace@local.invalid",
      emailVerified: false,
    });

    const refreshed = await app.inject({
      method: "POST",
      url: "/api/auth/oauth2/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: clientId,
        refresh_token: credentials.refresh_token,
      }).toString(),
    });
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json().access_token).not.toBe(credentials.access_token);

    await app.close();
    await auth.close();
  });

  it("rejects raw paths that would normalize into a token endpoint past the lifecycle gate", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cata-auth-path-"));
    dirs.push(dataDir);
    const baseURL = "http://127.0.0.1:4700";
    const auth = createWorkAuth({
      database: await openWorkAuthDatabase({ dataDir }),
      baseURL,
      secret: "auth-path-test-secret-with-at-least-32-characters",
      rateLimit: false,
    });
    await auth.migrate();
    const calls: string[] = [];
    const app = Fastify();
    registerWorkAuthRoutes(app, {
      auth,
      baseURL,
      methods: { local: true, providers: [] },
      tokenGate: {
        beforeRefresh: async ({ refreshToken }) => {
          calls.push(refreshToken);
          return {
            allow: false,
            error: "invalid_grant",
            description: "Work gate refused refresh",
          };
        },
        afterGrant: async () => ({ allow: true }),
      },
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing auth test address");
    const port = address.port;
    // fetch and app.inject normalize these paths before sending. Use raw
    // HTTP to exercise the actual boundary between Fastify and Request URLs.
    const post = (rawPath: string) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const request = httpRequest(
          {
            host: "127.0.0.1",
            port,
            method: "POST",
            path: rawPath,
            headers: { "content-type": "application/x-www-form-urlencoded" },
          },
          (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk: Buffer) => chunks.push(chunk));
            response.on("error", reject);
            response.on("end", () =>
              resolve({
                status: response.statusCode ?? 0,
                body: Buffer.concat(chunks).toString("utf8"),
              }),
            );
          },
        );
        request.on("error", reject);
        request.end(
          "grant_type=refresh_token&refresh_token=test-refresh&client_id=test-client",
        );
      });
    try {
      const response = await post("/api/auth/oauth2/token");
      expect(response.status).toBe(400);
      expect(response.body).toContain("Work gate refused refresh");
      expect(calls).toHaveLength(1);
      for (const endpoint of [
        "/api/auth/mcp/token",
        "/api/auth/unused/../oauth2/token",
        "/api/auth/%2e/oauth2/token",
        "/api/auth/unused/%2e%2e/oauth2/token",
        "/api/auth/unused/../mcp/token",
      ]) {
        expect((await post(endpoint)).status).toBe(404);
      }
      expect(calls).toHaveLength(1);
    } finally {
      await app.close();
      await auth.close();
    }
  });
});
