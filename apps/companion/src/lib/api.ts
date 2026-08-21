import {
  type CatamorphicApiClient,
  createCatamorphicClient,
} from "@catamorphic/api-client";
import type { CompanionConnection } from "./store.js";

/**
 * One typed client per connection, authed with its bearer token. The
 * connect link's `server` is the API base INCLUDING the mount prefix
 * (".../api"), while the generated client's path templates already carry
 * "/api/..." — so the client's baseUrl is the server origin without it.
 */
const clients = new Map<string, CatamorphicApiClient>();

export function clientBaseUrl(serverUrl: string): string {
  return serverUrl.replace(/\/+$/, "").replace(/\/api$/, "");
}

export function authedFetch(token: string): typeof fetch {
  return (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${token}`);
    return fetch(input, { ...init, headers });
  };
}

export function clientFor(
  connection: CompanionConnection,
): CatamorphicApiClient {
  const key = `${connection.id}:${connection.token}`;
  const cached = clients.get(key);
  if (cached) return cached;
  const client = createCatamorphicClient({
    baseUrl: clientBaseUrl(connection.serverUrl),
    fetch: authedFetch(connection.token),
  });
  clients.set(key, client);
  return client;
}

/** GET against the connection's API base (server-relative path). */
export async function apiGet(
  connection: Pick<CompanionConnection, "serverUrl" | "token">,
  path: string,
): Promise<Response> {
  const base = connection.serverUrl.replace(/\/+$/, "");
  return fetch(`${base}${path}`, {
    headers: { authorization: `Bearer ${connection.token}` },
  });
}

export interface RemoteMe {
  version: number;
  identity: { externalUserId: string; root: boolean };
  projects: Array<{
    projectId: string;
    builder: boolean;
    agents: string[];
    workflows: string[];
    apps: string[];
    documents: Array<{ path: string; access: "read" | "write" }>;
  }>;
  features: Record<string, unknown>;
}

export async function fetchMe(
  connection: Pick<CompanionConnection, "serverUrl" | "token">,
): Promise<RemoteMe> {
  const response = await apiGet(connection, "/me");
  if (!response.ok) {
    throw new Error(
      response.status === 401
        ? "This invite is no longer valid."
        : `The server said ${response.status}.`,
    );
  }
  return (await response.json()) as RemoteMe;
}
