import type { GithubServiceConfig, Identity } from "@catamorphic/core";
import type { StoredGithubConnection } from "@catamorphic/server-sdk";

/** The stock host's service credential. It never becomes a member credential. */
export function stockGithub({
  env,
  tenantId,
}: {
  env: Record<string, string | undefined>;
  tenantId: string;
}):
  | { config: GithubServiceConfig; identity: Identity; accessToken: string }
  | undefined {
  const accessToken = env.CATAMORPHIC_GITHUB_TOKEN;
  const clientId = env.CATAMORPHIC_GITHUB_CLIENT_ID;
  if (!accessToken && !clientId) return undefined;
  if (!accessToken || !clientId)
    throw new Error(
      "Configure both CATAMORPHIC_GITHUB_TOKEN and CATAMORPHIC_GITHUB_CLIENT_ID for the server's GitHub connection",
    );
  const identity: Identity = {
    tenantId,
    externalUserId: "stock-github-service",
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
              "The stock GitHub connection is reserved for the server service identity",
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
