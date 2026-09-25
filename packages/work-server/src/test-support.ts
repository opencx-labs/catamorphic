import { createHash, randomBytes } from "node:crypto";
import { workServerConfigFromEnv } from "./config.js";
import type { WorkServerOptions } from "./server.js";

/** Test servers boot from the same env parser as the image. */
export function testServerOptions(args: {
  dataDir: string;
  publicBases?: string[];
  env: Record<string, string | undefined>;
}): WorkServerOptions {
  return {
    config: {
      ...workServerConfigFromEnv(args.env),
      dataDir: args.dataDir,
      ...(args.publicBases ? { publicBases: args.publicBases } : {}),
    },
  };
}

interface InjectableApp {
  inject(options: {
    method: "GET" | "POST";
    url: string;
    headers?: Record<string, string>;
    payload?: unknown;
  }): Promise<{
    statusCode: number;
    headers: Record<string, string | string[] | number | undefined>;
    json(): Record<string, unknown>;
  }>;
}

/**
 * The OAuth flow an MCP client runs, in process: local sign-in, dynamic
 * client registration, PKCE authorization, and the code exchange.
 */
export async function oauthAccessToken(args: {
  app: InjectableApp;
  username: string;
  password: string;
}): Promise<string> {
  const { app } = args;
  const expectStatus = (step: string, actual: number, expected: number) => {
    if (actual !== expected)
      throw new Error(`${step} answered ${actual}, expected ${expected}`);
  };
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/sign-in/username",
    payload: { username: args.username, password: args.password },
  });
  expectStatus("sign-in", login.statusCode, 200);
  const setCookie = login.headers["set-cookie"];
  const cookie = String(Array.isArray(setCookie) ? setCookie[0] : setCookie);

  const redirectUri = "http://127.0.0.1:49152/callback";
  const registered = await app.inject({
    method: "POST",
    url: "/api/auth/mcp/register",
    payload: {
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: "Work server test",
    },
  });
  expectStatus("registration", registered.statusCode, 201);
  const clientId = String(registered.json().client_id);
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorize = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid profile email offline_access",
    state: "work-server-state",
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  const authorized = await app.inject({
    method: "GET",
    url: `/api/auth/mcp/authorize?${authorize}`,
    headers: { cookie },
  });
  expectStatus("authorization", authorized.statusCode, 302);
  const code =
    new URL(String(authorized.headers.location ?? "")).searchParams.get(
      "code",
    ) ?? "";

  const token = await app.inject({
    method: "POST",
    url: "/api/auth/mcp/token",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      redirect_uri: redirectUri,
      code,
      code_verifier: verifier,
    }).toString(),
  });
  expectStatus("token", token.statusCode, 200);
  return String(token.json().access_token);
}
