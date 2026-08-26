import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import http from "node:http";

interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
}

interface AuthorizationServerMetadata {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
  code_challenge_methods_supported?: string[];
}

export interface RemoteOAuthCredentials {
  clientId: string;
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: string;
  tokenEndpoint: string;
  scope: string;
}

export async function refreshRemoteCredentials(options: {
  credentials: RemoteOAuthCredentials;
  fetch?: typeof fetch;
}): Promise<RemoteOAuthCredentials> {
  const response = await (options.fetch ?? fetch)(
    options.credentials.tokenEndpoint,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: options.credentials.clientId,
        refresh_token: options.credentials.refreshToken,
      }).toString(),
    },
  );
  if (!response.ok) {
    throw new Error(`Remote access refresh failed (${response.status})`);
  }
  const token = (await response.json()) as Record<string, unknown>;
  if (
    typeof token.access_token !== "string" ||
    typeof token.refresh_token !== "string" ||
    typeof token.expires_in !== "number"
  ) {
    throw new Error("Remote access refresh returned incomplete credentials");
  }
  return {
    ...options.credentials,
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    accessTokenExpiresAt: new Date(
      Date.now() + token.expires_in * 1000,
    ).toISOString(),
    scope:
      typeof token.scope === "string" ? token.scope : options.credentials.scope,
  };
}

export async function authorizeRemoteServer(options: {
  serverUrl: string;
  fetch?: typeof fetch;
  openExternal(url: string): Promise<void>;
  timeoutMs?: number;
}): Promise<RemoteOAuthCredentials> {
  const fetchImpl = options.fetch ?? fetch;
  const server = new URL(options.serverUrl);
  const protectedResource = await fetchJson<ProtectedResourceMetadata>(
    fetchImpl,
    new URL("/.well-known/oauth-protected-resource", server.origin),
  );
  const authorizationServer = protectedResource.authorization_servers[0];
  if (!authorizationServer) {
    throw new Error("The remote server published no authorization server");
  }
  const metadata = await fetchJson<AuthorizationServerMetadata>(
    fetchImpl,
    new URL("/.well-known/oauth-authorization-server", authorizationServer),
  );
  if (!metadata.code_challenge_methods_supported?.includes("S256")) {
    throw new Error("The remote server does not support S256 PKCE");
  }

  const callback = await openLoopbackCallback(options.timeoutMs ?? 120_000);
  try {
    const registration = await fetchImpl(metadata.registration_endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: [callback.url],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        client_name: "Catamorphic desktop",
      }),
    });
    if (!registration.ok) {
      throw new Error(
        `Remote client registration failed (${registration.status})`,
      );
    }
    const registered = (await registration.json()) as { client_id?: unknown };
    if (typeof registered.client_id !== "string" || !registered.client_id) {
      throw new Error("Remote client registration returned no client id");
    }

    const verifier = randomBytes(48).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const state = randomBytes(32).toString("base64url");
    const authorize = new URL(metadata.authorization_endpoint);
    authorize.searchParams.set("client_id", registered.client_id);
    authorize.searchParams.set("redirect_uri", callback.url);
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("scope", "openid profile email offline_access");
    authorize.searchParams.set("state", state);
    authorize.searchParams.set("code_challenge", challenge);
    authorize.searchParams.set("code_challenge_method", "S256");
    await options.openExternal(authorize.toString());
    const result = await callback.result;
    if (!constantTimeTextEqual(result.state, state)) {
      throw new Error("Remote authorization returned an invalid state");
    }
    if (result.error) {
      throw new Error(`Remote authorization failed: ${result.error}`);
    }
    if (!result.code) {
      throw new Error("Remote authorization returned no code");
    }

    const tokenResponse = await fetchImpl(metadata.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: registered.client_id,
        redirect_uri: callback.url,
        code: result.code,
        code_verifier: verifier,
      }).toString(),
    });
    if (!tokenResponse.ok) {
      throw new Error(`Remote token exchange failed (${tokenResponse.status})`);
    }
    const token = (await tokenResponse.json()) as Record<string, unknown>;
    if (
      typeof token.access_token !== "string" ||
      typeof token.refresh_token !== "string" ||
      typeof token.expires_in !== "number"
    ) {
      throw new Error("Remote token exchange returned incomplete credentials");
    }
    return {
      clientId: registered.client_id,
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      accessTokenExpiresAt: new Date(
        Date.now() + token.expires_in * 1000,
      ).toISOString(),
      tokenEndpoint: metadata.token_endpoint,
      scope: typeof token.scope === "string" ? token.scope : "",
    };
  } finally {
    await callback.close();
  }
}

async function fetchJson<T>(fetchImpl: typeof fetch, url: URL): Promise<T> {
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(
      `Remote authorization discovery failed (${response.status})`,
    );
  }
  return (await response.json()) as T;
}

async function openLoopbackCallback(timeoutMs: number): Promise<{
  url: string;
  result: Promise<{ code?: string; state: string; error?: string }>;
  close(): Promise<void>;
}> {
  let resolveResult:
    | ((value: { code?: string; state: string; error?: string }) => void)
    | undefined;
  let rejectResult: ((error: Error) => void) | undefined;
  const result = new Promise<{ code?: string; state: string; error?: string }>(
    (resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    },
  );
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      "<!doctype html><meta charset=utf-8><title>Connected</title><p>Connected. You can return to Catamorphic.</p>",
    );
    resolveResult?.({
      ...(url.searchParams.get("code")
        ? { code: url.searchParams.get("code") ?? undefined }
        : {}),
      state: url.searchParams.get("state") ?? "",
      ...(url.searchParams.get("error")
        ? { error: url.searchParams.get("error") ?? undefined }
        : {}),
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not open the local authorization callback");
  }
  const timer = setTimeout(() => {
    rejectResult?.(new Error("Remote authorization timed out"));
  }, timeoutMs);
  timer.unref();
  return {
    url: `http://127.0.0.1:${address.port}/callback`,
    result: result.finally(() => clearTimeout(timer)),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function constantTimeTextEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
