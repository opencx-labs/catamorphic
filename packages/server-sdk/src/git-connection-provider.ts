import type { ConnectionProvider } from "@catamorphic/core";

export interface GitConnectionOptions {
  kind: string;
  displayName: string;
  /**
   * The remotes this connection serves: an HTTPS URL prefix such as
   * `https://git.example.com/` (loopback may use HTTP).
   */
  baseUrl: string;
}

const GIT_CAPABILITIES = ["git:read", "git:write"];

/**
 * A plain Git host reached through the gateway (ADR 0175). An operator or
 * member stores a username and password or token once; the gateway uses it
 * for fetches and pushes that sandboxes make with their session grant, so
 * the credential never reaches a sandbox. It has no other actions.
 */
export function defineGitConnectionProvider(
  options: GitConnectionOptions,
): ConnectionProvider {
  const base = new URL(options.baseUrl);
  if (base.protocol !== "https:" && !isLoopback(base.hostname))
    throw new Error(`${options.kind}: baseUrl must use HTTPS`);
  const prefix = base.href.endsWith("/") ? base.href : `${base.href}/`;
  return {
    kind: options.kind,
    displayName: options.displayName,
    git: {
      remoteBaseUrls: [prefix],
      credentials: async ({ material, remoteUrl }) => {
        if (!remoteUrl.startsWith(prefix))
          throw new Error(`${options.kind} serves only ${prefix}`);
        return decodeCredential(material);
      },
    },
    beginAuthorization: async () => ({
      challenge: {
        kind: "form",
        fields: [
          {
            name: "username",
            label: "Username",
            secret: false,
            required: false,
          },
          {
            name: "password",
            label: "Password or access token",
            secret: true,
            required: true,
          },
        ],
      },
    }),
    completeAuthorization: async ({ callback }) => {
      const password = callback.password?.trim();
      if (!password) throw new Error("A password or access token is required");
      const username = callback.username?.trim() || "git";
      return {
        material: new TextEncoder().encode(
          JSON.stringify({ username, password }),
        ),
        account: { username },
        capabilities: GIT_CAPABILITIES,
      };
    },
    listActions: async () => [],
    invoke: async () => {
      throw new Error(
        `${options.displayName} is reached with Git through the gateway, not with actions`,
      );
    },
  };
}

function decodeCredential(material: Uint8Array): {
  username: string;
  password: string;
} {
  const value: unknown = JSON.parse(new TextDecoder().decode(material));
  if (
    value &&
    typeof value === "object" &&
    "username" in value &&
    "password" in value &&
    typeof value.username === "string" &&
    typeof value.password === "string"
  )
    return { username: value.username, password: value.password };
  throw new Error("The stored Git credential is unreadable");
}

function isLoopback(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname.endsWith(".localhost")
  );
}
