import type { GithubServiceConfig, Identity } from "@catamorphic/core";
import type { StoredGithubConnection } from "@catamorphic/server-sdk";

/** The Work server's service credential. It never becomes a member credential. */
export function workGithub({
  settings,
  tenantId,
}: {
  settings: { clientId: string; token: string } | undefined;
  tenantId: string;
}):
  | { config: GithubServiceConfig; identity: Identity; accessToken: string }
  | undefined {
  if (!settings) return undefined;
  const { clientId, token: accessToken } = settings;
  const identity: Identity = {
    tenantId,
    externalUserId: "work-github-service",
  };
  // The operator supplies the token on every boot. No member OAuth token or
  // token copy is persisted; GitHubService validates the account before use.
  let connection: StoredGithubConnection | null = null;
  const owns = (tenant: string, user: string) =>
    tenant === tenantId && user === identity.externalUserId;
  return {
    identity,
    accessToken,
    config: {
      app: { clientId },
      tokenStore: {
        get: async (tenant, user) => (owns(tenant, user) ? connection : null),
        set: async (tenant, user, value) => {
          if (!owns(tenant, user))
            throw new Error(
              "The Work server GitHub connection is reserved for the server service identity",
            );
          connection = value;
        },
        delete: async (tenant, user) => {
          if (owns(tenant, user)) connection = null;
        },
      },
    },
  };
}
