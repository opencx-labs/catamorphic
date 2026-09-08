import { createApiClient } from "@catamorphic/api-client";
import { CatamorphicProvider, useCatamorphic } from "@catamorphic/react";
import { QueryClient, useQuery } from "@tanstack/react-query";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
} from "react";
import { desktopApi } from "../lib/desktop-api.js";

const RemoteAuthority = createContext<{
  remoteProjectId: string;
  serverUrl: string;
  builder: boolean;
} | null>(null);
export const useRemoteAuthority = () => useContext(RemoteAuthority);
const authorityCaches = new Map<string, QueryClient>();
const authorityUsers = new Map<QueryClient, number>();

/** Keep global connection/auth routes and caches with the project's authority. */
export function ProjectAuthorityProvider({
  projectId,
  children,
  localOnly = false,
}: {
  projectId: string;
  children: ReactNode;
  localOnly?: boolean;
}) {
  const local = useCatamorphic();
  const authority = useQuery({
    queryKey: ["desktop", "project-authority", projectId],
    queryFn: () => desktopApi.remoteAuthority(projectId),
    staleTime: 0,
  });
  const remote = authority.data;
  const context = useMemo(() => {
    if (!remote) return null;
    const key = `${remote.connectionId}:${remote.credentialEpoch}`;
    for (const [existing, client] of authorityCaches) {
      if (existing.startsWith(`${remote.connectionId}:`) && existing !== key) {
        client.clear();
        authorityCaches.delete(existing);
      }
    }
    let queries = authorityCaches.get(key);
    if (!queries) {
      queries = new QueryClient({
        defaultOptions: { queries: { retry: 1, staleTime: 1000 } },
      });
    }
    const baseUrl = `${local.apiClient.baseUrl.replace(/\/+$/, "")}/desktop/projects/${encodeURIComponent(projectId)}/remote-api`;
    return {
      queries,
      apiClient: createApiClient({ baseUrl, fetch: local.apiClient.fetch }),
    };
  }, [remote, projectId, local.apiClient.baseUrl, local.apiClient.fetch]);
  useEffect(() => {
    if (!context || !remote) return;
    const { queries } = context;
    const key = `${remote.connectionId}:${remote.credentialEpoch}`;
    authorityUsers.set(queries, (authorityUsers.get(queries) ?? 0) + 1);
    authorityCaches.set(key, queries);
    return () => {
      const count = (authorityUsers.get(queries) ?? 1) - 1;
      if (count > 0) {
        authorityUsers.set(queries, count);
        return;
      }
      authorityUsers.delete(queries);
      if (authorityCaches.get(key) === queries) authorityCaches.delete(key);
      queries.clear();
    };
  }, [context, remote]);
  const member = useQuery({
    queryKey: [
      "desktop",
      "remote-member",
      remote?.connectionId,
      remote?.credentialEpoch,
    ],
    enabled: Boolean(context),
    queryFn: async () => {
      const response = await context!.apiClient.GET("/api/me");
      if (!response.data) throw new Error("Project access unavailable");
      return response.data;
    },
    refetchInterval: 10000,
  });
  if (authority.isPending)
    return (
      <p role="status" className="p-3 text-sm text-fg-muted">
        Loading project access…
      </p>
    );
  if (authority.error)
    return (
      <p role="alert" className="p-3 text-sm text-danger">
        {authority.error.message}
      </p>
    );
  if (!context || !remote) return children;
  if (localOnly)
    return (
      <p role="alert" className="p-3 text-sm text-fg-muted">
        This incognito chat stays on this computer. Open a new chat to work with
        the remote project.
      </p>
    );
  return (
    <CatamorphicProvider
      apiClient={context.apiClient}
      queryClient={context.queries}
      baseUrl={new URL(remote.serverUrl).origin}
      authorizationRedirectUri={`${remote.serverUrl.replace(/\/+$/, "")}/connection-authorizations/callback`}
    >
      <RemoteAuthority.Provider
        value={{
          ...remote,
          builder:
            member.data?.projects.some(
              (project) =>
                project.projectId === remote.remoteProjectId && project.builder,
            ) ?? false,
        }}
      >
        {children}
      </RemoteAuthority.Provider>
    </CatamorphicProvider>
  );
}
