import type { QueryClient } from "@tanstack/react-query";

/**
 * Query clients that read a remote project's server, by connection and
 * credential epoch (`ProjectAuthorityProvider`), and how many views use
 * each. Every other client reads this computer's own server.
 */
export const remoteQueryClients = new Map<string, QueryClient>();
export const remoteQueryClientUsers = new Map<QueryClient, number>();

/** Whether a query client reads a remote project's server. */
export function isRemoteQueryClient(client: QueryClient): boolean {
  return (
    remoteQueryClientUsers.has(client) ||
    [...remoteQueryClients.values()].includes(client)
  );
}
