import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { openStockAuthDatabase } from "./auth-database.js";
import { registerStockAuthRoutes } from "./fastify-auth.js";
import { createStockAuth } from "./stock-auth.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true });
});

describe("stock Fastify OAuth bridge", () => {
  it("authorizes and refreshes a public PKCE client", async () => {
    const dataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "cata-fastify-auth-"),
    );
    dirs.push(dataDir);
    const baseURL = "http://127.0.0.1:4700";
    const database = await openStockAuthDatabase({ dataDir });
    const auth = createStockAuth({
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
    registerStockAuthRoutes(app, {
      auth,
      baseURL,
      methods: { local: true, providers: [] },
    });

    const metadata = await app.inject({
      method: "GET",
      url: "/.well-known/oauth-authorization-server",
    });
    expect(metadata.statusCode).toBe(200);
    expect(metadata.json().code_challenge_methods_supported).toEqual(["S256"]);

    const redirectUri = "http://127.0.0.1:49152/callback";
    const registered = await app.inject({
      method: "POST",
      url: "/api/auth/mcp/register",
      payload: {
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        client_name: "Catamorphic desktop",
      },
    });
    expect(registered.statusCode).toBe(201);
    const clientId = registered.json().client_id as string;
    expect(registered.json().client_secret).toBeUndefined();

    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const authorize = new URL("/api/auth/mcp/authorize", baseURL);
    authorize.searchParams.set("client_id", clientId);
    authorize.searchParams.set("redirect_uri", redirectUri);
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("scope", "openid profile email offline_access");
    authorize.searchParams.set("state", "state-1");
    authorize.searchParams.set("code_challenge", challenge);
    authorize.searchParams.set("code_challenge_method", "S256");
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
    expect(loginPage.body).toContain('autocomplete="username"');
    expect(loginPage.body).toContain('autocomplete="current-password"');
    expect(loginPage.body).toContain('id="toggle-password"');
    expect(loginPage.headers["content-security-policy"]).toContain(
      "frame-ancestors 'none'",
    );

    const consent = await app.inject({
      method: "GET",
      url: "/oauth/consent?consent_code=one&client_id=desktop-client&scope=openid%20offline_access",
    });
    expect(consent.statusCode).toBe(200);
    expect(consent.body).toContain("Allow this connection?");
    expect(consent.body).toContain("desktop-client");
    expect(consent.body).toContain("offline access");
    expect(consent.body).toContain("Allow access");

    const promptCookie = prompted.headers["set-cookie"];
    const login = await app.inject({
      method: "POST",
      url: `/login/local${authorize.search}`,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: Array.isArray(promptCookie) ? promptCookie[0] : promptCookie,
      },
      payload: new URLSearchParams({
        username: "grace",
        password: "correct horse battery staple",
      }).toString(),
    });
    expect(login.statusCode).toBe(302);
    expect(login.headers.location).toContain(`${redirectUri}?code=`);
    const cookie = login.headers["set-cookie"];
    expect(cookie).toBeTruthy();

    const callback = new URL(login.headers.location ?? "");
    expect(callback.searchParams.get("state")).toBe("state-1");
    const code = callback.searchParams.get("code");
    expect(code).toBeTruthy();

    const token = await app.inject({
      method: "POST",
      url: "/api/auth/mcp/token",
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
      url: "/api/auth/mcp/token",
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
});
