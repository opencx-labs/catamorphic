import {
  type CatamorphicApiClient,
  createCatamorphicClient,
} from "@catamorphic/api-client";
import {
  SESSION_PROTOCOL_MISMATCH_MESSAGE,
  speaksSessionProtocol,
} from "@catamorphic/react";
import { refreshRemoteCredentials } from "./oauth.js";
import {
  connectionById,
  getState,
  type PwaConnection,
  subscribe,
  updateRemoteCredentials,
} from "./store.js";

/**
 * One typed client per connection, authenticated through its live credential
 * supplier. The
 * connect link's `server` is the API base INCLUDING the mount prefix
 * (".../api"), while the generated client's path templates already carry
 * "/api/..." — so the client's baseUrl is the server origin without it.
 */
const clients = new Map<string, CatamorphicApiClient>();
const refreshes = new Map<string, Promise<string>>();
subscribe(() => {
  for (const id of clients.keys())
    if (!connectionById(getState(), id)) clients.delete(id);
});

export function clientBaseUrl(serverUrl: string): string {
  return serverUrl.replace(/\/+$/, "").replace(/\/api$/, "");
}

export function authenticatedFetch(options: {
  connectionId: string;
  fetch?: typeof fetch;
  now?: () => number;
}): typeof fetch {
  const fetchImpl = options.fetch ?? fetch;
  return async (input, init) => {
    const original = new Request(input, init);
    const firstToken = await accessToken({
      connectionId: options.connectionId,
      fetch: fetchImpl,
      now: options.now,
    });
    const first = original.clone();
    first.headers.set("authorization", `Bearer ${firstToken}`);
    const response = await fetchImpl(first);
    if (response.status !== 401) return response;
    const connection = connectionById(getState(), options.connectionId);
    if (connection?.kind !== "remote" || !connection.credentials) {
      return response;
    }
    const refreshedToken = await accessToken({
      connectionId: options.connectionId,
      fetch: fetchImpl,
      now: options.now,
      forceRefresh: true,
    });
    const retry = original.clone();
    retry.headers.set("authorization", `Bearer ${refreshedToken}`);
    return fetchImpl(retry);
  };
}

export function clientFor(connection: PwaConnection): CatamorphicApiClient {
  const key = connection.id;
  const cached = clients.get(key);
  if (cached) return cached;
  const client = createCatamorphicClient({
    baseUrl: clientBaseUrl(connection.serverUrl),
    fetch: authenticatedFetch({ connectionId: connection.id }),
  });
  clients.set(key, client);
  return client;
}

/**
 * POST JSON to an arbitrary origin path. The one pre-auth request in the
 * app (the QR pair claim) goes through here so a native wrap swapping
 * the transport still has a single seam.
 */
export async function postJson(
  origin: string,
  path: string,
  body: unknown,
): Promise<Response> {
  return fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** GET against the connection's API base (server-relative path). */
export async function apiGet(
  connection: Pick<PwaConnection, "id" | "serverUrl">,
  path: string,
): Promise<Response> {
  const base = connection.serverUrl.replace(/\/+$/, "");
  return authenticatedFetch({ connectionId: connection.id })(`${base}${path}`);
}

export interface RemoteMe {
  version: number;
  identity: { externalUserId: string; root: boolean };
  projects: Array<{
    projectId: string;
    source: { remoteUrl: string; defaultBranch: string } | null;
    permissions: string[];
    agents: string[];
    workflows: string[];
    apps: string[];
    documents: Array<{ path: string; access: "read" | "write" }>;
  }>;
  features: Record<string, unknown>;
  /** The agent protocols the server speaks (ADR 0197). */
  agentProtocol?: { session?: number; runner?: number } | null;
}

/**
 * Refuse a server whose agent sessions speak another protocol version
 * (ADR 0197): its chats cannot be read or continued from this app.
 */
export function assertSessionProtocol(me: {
  agentProtocol?: { session?: number } | null;
}): void {
  if (!speaksSessionProtocol(me))
    throw new Error(SESSION_PROTOCOL_MISMATCH_MESSAGE);
}

/**
 * Check a server's protocol with a bearer token before keeping its
 * connection: pairing and sign-in hold a fresh token, not a stored one.
 */
export async function verifySessionProtocol(options: {
  serverUrl: string;
  accessToken: string;
  fetch?: typeof fetch;
}): Promise<void> {
  const response = await (options.fetch ?? fetch)(
    `${options.serverUrl.replace(/\/+$/, "")}/me`,
    { headers: { authorization: `Bearer ${options.accessToken}` } },
  );
  if (!response.ok)
    throw new Error(
      `The server could not confirm its version (${response.status}).`,
    );
  const me: { agentProtocol?: { session?: number } | null } =
    await response.json();
  assertSessionProtocol(me);
}

export async function fetchMe(
  connection: Pick<PwaConnection, "id" | "serverUrl">,
): Promise<RemoteMe> {
  const response = await apiGet(connection, "/me");
  if (!response.ok) {
    throw new Error(
      response.status === 401
        ? "Sign in to this server again."
        : `The server said ${response.status}.`,
    );
  }
  const me = (await response.json()) as RemoteMe;
  assertSessionProtocol(me);
  return me;
}

async function accessToken(options: {
  connectionId: string;
  fetch: typeof fetch;
  now?: () => number;
  forceRefresh?: boolean;
}): Promise<string> {
  const connection = connectionById(getState(), options.connectionId);
  if (!connection) throw new Error("This connection is no longer available");
  if (connection.kind === "device") return connection.credentials.accessToken;
  if (!connection.credentials) {
    throw new Error("Sign in to this server before continuing");
  }
  const expiresAt = Date.parse(connection.credentials.accessTokenExpiresAt);
  const shouldRefresh =
    options.forceRefresh === true ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= (options.now ?? Date.now)() + 30_000;
  if (!shouldRefresh) return connection.credentials.accessToken;

  const refreshKey = `${connection.serverUrl}\0${connection.credentials.clientId}`;
  const existing = refreshes.get(refreshKey);
  if (existing) return existing;
  const refresh = refreshRemoteCredentials({
    credentials: connection.credentials,
    fetch: options.fetch,
    ...(options.now ? { now: options.now } : {}),
  })
    .then((credentials) => {
      updateRemoteCredentials(connection.id, credentials);
      return credentials.accessToken;
    })
    .finally(() => refreshes.delete(refreshKey));
  refreshes.set(refreshKey, refresh);
  return refresh;
}
