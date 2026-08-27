import { sha256 } from "@noble/hashes/sha2.js";
import { type ConnectLink, isSecureRemoteUrl } from "./connect-link.js";
import type { RemoteOAuthCredentials } from "./store.js";

const PENDING_KEY = "catamorphic-pwa.oauth.pending";
const OAUTH_SCOPE = "openid profile email offline_access";

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

export type RemoteAuthorizationTarget =
  | { kind: "project"; link: ConnectLink }
  | { kind: "server"; serverUrl: string };

interface PendingAuthorization {
  version: 1;
  target: RemoteAuthorizationTarget;
  state: string;
  verifier: string;
  clientId: string;
  redirectUri: string;
  tokenEndpoint: string;
}

export async function beginRemoteAuthorization(options: {
  link: ConnectLink;
  redirectUri: string;
  storage?: Storage;
  fetch?: typeof fetch;
}): Promise<{ authorizationUrl: string }> {
  return beginAuthorization({
    target: { kind: "project", link: options.link },
    redirectUri: options.redirectUri,
    ...(options.storage ? { storage: options.storage } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
}

export async function beginServerAuthorization(options: {
  serverUrl: string;
  redirectUri: string;
  storage?: Storage;
  fetch?: typeof fetch;
}): Promise<{ authorizationUrl: string }> {
  const serverUrl = options.serverUrl.replace(/\/+$/, "");
  return beginAuthorization({
    target: { kind: "server", serverUrl },
    redirectUri: options.redirectUri,
    ...(options.storage ? { storage: options.storage } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
}

async function beginAuthorization(options: {
  target: RemoteAuthorizationTarget;
  redirectUri: string;
  storage?: Storage;
  fetch?: typeof fetch;
}): Promise<{ authorizationUrl: string }> {
  const storage = options.storage ?? sessionStorage;
  const fetchImpl = options.fetch ?? fetch;
  const serverUrl =
    options.target.kind === "project"
      ? options.target.link.serverUrl
      : options.target.serverUrl;
  assertSecureRemoteUrl(serverUrl);
  const server = new URL(serverUrl);
  const resource = await fetchJson<ProtectedResourceMetadata>(
    fetchImpl,
    new URL("/.well-known/oauth-protected-resource", server.origin),
  );
  if (resource.resource !== serverUrl.replace(/\/+$/, "")) {
    throw new Error(
      "The remote server published authorization for a different requested resource",
    );
  }
  const authorizationServer = resource.authorization_servers[0];
  if (!authorizationServer) {
    throw new Error("The remote server published no authorization server");
  }
  assertSecureRemoteUrl(authorizationServer);
  if (new URL(authorizationServer).origin !== server.origin) {
    throw new Error(
      "The remote authorization server must use the same origin as the requested server",
    );
  }
  const metadata = await fetchJson<AuthorizationServerMetadata>(
    fetchImpl,
    new URL("/.well-known/oauth-authorization-server", authorizationServer),
  );
  if (!metadata.code_challenge_methods_supported?.includes("S256")) {
    throw new Error("The remote server does not support S256 PKCE");
  }
  for (const endpoint of [
    metadata.authorization_endpoint,
    metadata.token_endpoint,
    metadata.registration_endpoint,
  ]) {
    assertSecureRemoteUrl(endpoint);
    if (new URL(endpoint).origin !== server.origin) {
      throw new Error(
        "Remote authorization endpoints must use the same origin as the requested server",
      );
    }
  }
  const registration = await fetchImpl(metadata.registration_endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      redirect_uris: [options.redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: "Catamorphic mobile",
    }),
  });
  if (!registration.ok) {
    throw new Error(
      `Remote client registration failed (${registration.status})`,
    );
  }
  const registered = (await registration.json()) as Record<string, unknown>;
  if (
    typeof registered.client_id !== "string" ||
    registered.client_id.length === 0
  ) {
    throw new Error("Remote client registration returned no client id");
  }

  const verifier = randomText(48);
  const state = randomText(32);
  const pending: PendingAuthorization = {
    version: 1,
    target: options.target,
    state,
    verifier,
    clientId: registered.client_id,
    redirectUri: options.redirectUri,
    tokenEndpoint: metadata.token_endpoint,
  };
  storage.setItem(PENDING_KEY, JSON.stringify(pending));

  const authorization = new URL(metadata.authorization_endpoint);
  authorization.searchParams.set("client_id", registered.client_id);
  authorization.searchParams.set("redirect_uri", options.redirectUri);
  authorization.searchParams.set("response_type", "code");
  authorization.searchParams.set("scope", OAUTH_SCOPE);
  authorization.searchParams.set("state", state);
  authorization.searchParams.set(
    "code_challenge",
    base64Url(sha256(new TextEncoder().encode(verifier))),
  );
  authorization.searchParams.set("code_challenge_method", "S256");
  return { authorizationUrl: authorization.toString() };
}

export async function completeRemoteAuthorization(options: {
  callbackUrl: string;
  storage?: Storage;
  fetch?: typeof fetch;
  now?: () => number;
}): Promise<{
  target: RemoteAuthorizationTarget;
  credentials: RemoteOAuthCredentials;
}> {
  const storage = options.storage ?? sessionStorage;
  const raw = storage.getItem(PENDING_KEY);
  storage.removeItem(PENDING_KEY);
  const pending = parsePending(raw);
  const callback = new URL(options.callbackUrl);
  if (callback.searchParams.get("state") !== pending.state) {
    throw new Error("Remote authorization returned an invalid state");
  }
  const providerError = callback.searchParams.get("error");
  if (providerError) {
    throw new Error(`Remote authorization failed: ${providerError}`);
  }
  const code = callback.searchParams.get("code");
  if (!code) throw new Error("Remote authorization returned no code");

  const response = await (options.fetch ?? fetch)(pending.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: pending.clientId,
      redirect_uri: pending.redirectUri,
      code,
      code_verifier: pending.verifier,
    }).toString(),
  });
  if (!response.ok) {
    throw new Error(`Remote token exchange failed (${response.status})`);
  }
  const token = await tokenPayload(response);
  return {
    target: pending.target,
    credentials: {
      clientId: pending.clientId,
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      accessTokenExpiresAt: new Date(
        (options.now ?? Date.now)() + token.expiresIn * 1000,
      ).toISOString(),
      tokenEndpoint: pending.tokenEndpoint,
      scope: token.scope,
    },
  };
}

export async function refreshRemoteCredentials(options: {
  credentials: RemoteOAuthCredentials;
  fetch?: typeof fetch;
  now?: () => number;
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
  const raw = (await response.json()) as Record<string, unknown>;
  if (
    typeof raw.access_token !== "string" ||
    typeof raw.expires_in !== "number"
  ) {
    throw new Error("Remote access refresh returned incomplete credentials");
  }
  return {
    ...options.credentials,
    accessToken: raw.access_token,
    refreshToken:
      typeof raw.refresh_token === "string"
        ? raw.refresh_token
        : options.credentials.refreshToken,
    accessTokenExpiresAt: new Date(
      (options.now ?? Date.now)() + raw.expires_in * 1000,
    ).toISOString(),
    scope:
      typeof raw.scope === "string" ? raw.scope : options.credentials.scope,
  };
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

function parsePending(raw: string | null): PendingAuthorization {
  if (!raw) throw new Error("No remote authorization is waiting to finish");
  try {
    const value = JSON.parse(raw) as Partial<PendingAuthorization>;
    if (
      value.version === 1 &&
      validTarget(value.target) &&
      typeof value.state === "string" &&
      typeof value.verifier === "string" &&
      typeof value.clientId === "string" &&
      typeof value.redirectUri === "string" &&
      typeof value.tokenEndpoint === "string"
    ) {
      return value as PendingAuthorization;
    }
  } catch {
    // Stable error below.
  }
  throw new Error("The pending remote authorization is invalid");
}

function validTarget(
  target: RemoteAuthorizationTarget | undefined,
): target is RemoteAuthorizationTarget {
  if (!target) return false;
  if (target.kind === "server") return validServerUrl(target.serverUrl);
  return (
    target.kind === "project" &&
    validServerUrl(target.link?.serverUrl) &&
    typeof target.link.remoteProjectId === "string" &&
    target.link.remoteProjectId.length > 0
  );
}

function validServerUrl(value: unknown): value is string {
  return typeof value === "string" && isSecureRemoteUrl(value);
}

function assertSecureRemoteUrl(raw: string): void {
  if (!isSecureRemoteUrl(raw)) {
    throw new Error("Remote authorization requires HTTPS except on loopback");
  }
}

async function tokenPayload(response: Response): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scope: string;
}> {
  const token = (await response.json()) as Record<string, unknown>;
  if (
    typeof token.access_token !== "string" ||
    typeof token.refresh_token !== "string" ||
    typeof token.expires_in !== "number"
  ) {
    throw new Error("Remote token exchange returned incomplete credentials");
  }
  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresIn: token.expires_in,
    scope: typeof token.scope === "string" ? token.scope : "",
  };
}

function randomText(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return base64Url(bytes);
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
