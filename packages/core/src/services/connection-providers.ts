import type { Json } from "@catamorphic/db";

export type AuthorizationChallenge =
  | { kind: "url"; url: string; expiresAt?: string }
  | {
      kind: "device";
      verificationUrl: string;
      userCode: string;
      expiresAt?: string;
    }
  | {
      kind: "form";
      fields: {
        name: string;
        label: string;
        secret: boolean;
        required: boolean;
        /** Keeps line breaks, as a PEM key or a JSON document needs. */
        multiline?: boolean;
      }[];
    };

export interface ConnectionAuthorizationResult {
  material: Uint8Array;
  account?: Json;
  scopes?: readonly string[];
  capabilities?: readonly string[];
  expiresAt?: Date;
}

export interface ConnectionActionDefinition {
  name: string;
  description?: string;
  inputSchema: Json;
  annotations?: Json;
}

/**
 * Provider-neutral signal that saved authorization can no longer be used.
 * Providers in lower-level packages may throw any error with this stable code;
 * core converts it to an allocation-bound action requirement.
 */
export class ConnectionAuthorizationExpiredError extends Error {
  readonly code = "connection_authorization_expired";

  constructor(message = "Connection authorization has expired") {
    super(message);
    this.name = "ConnectionAuthorizationExpiredError";
  }
}

export function isConnectionAuthorizationExpiredError(
  value: unknown,
): value is Error & { code: "connection_authorization_expired" } {
  return (
    value instanceof Error &&
    "code" in value &&
    value.code === "connection_authorization_expired"
  );
}

/** HTTP Basic credentials for one Git remote, used once by the gateway. */
export interface GitRemoteCredentials {
  username: string;
  password: string;
  /** When the password stops working, for minted credentials. */
  expiresAt?: Date;
}

/**
 * A provider that can serve Git smart HTTP through the gateway (ADR 0175).
 * The gateway, never the sandbox, asks for credentials per remote and per
 * access level, and forwards Git traffic with them. Host-neutral: a code
 * host provider mints repository-scoped tokens, a plain Git provider may
 * return a stored password.
 */
export interface ConnectionGitRemotes {
  /** HTTPS URL prefixes of the remotes served, e.g. `https://github.com/`. */
  readonly remoteBaseUrls: readonly string[];
  credentials(args: {
    material: Uint8Array;
    /** HTTPS remote URL under one of `remoteBaseUrls`. */
    remoteUrl: string;
    access: "read" | "write";
  }): Promise<GitRemoteCredentials>;
}

/** The HTTP API family a model connection speaks (ADR 0180). */
export type ModelApi = "anthropic" | "openai";

/**
 * A provider whose connection holds a model provider's key (ADR 0180).
 * Harnesses in sandboxes reach its HTTP API through the gateway's model
 * routes with their session grant; the gateway adds the stored key.
 */
export interface ConnectionModelEndpoint {
  /**
   * `anthropic`: the Messages API below `baseUrl` (`v1/messages`,
   * `v1/messages/count_tokens`). `openai`: Responses and Chat Completions
   * below `baseUrl` (`responses`, `chat/completions`).
   */
  readonly api: ModelApi;
  /**
   * Where the API's paths go, e.g. `https://api.anthropic.com` or
   * `https://api.openai.com/v1` (an OpenAI-compatible server's base).
   */
  readonly baseUrl: string;
  /** The headers that carry the stored key on one upstream request. */
  headers(args: { material: Uint8Array }): Record<string, string>;
}

export interface ConnectionProvider {
  readonly kind: string;
  readonly displayName: string;
  /** Present when the gateway may forward Git traffic for this connection. */
  readonly git?: ConnectionGitRemotes;
  /** Present when the connection is a model API the gateway forwards to. */
  readonly model?: ConnectionModelEndpoint;
  /**
   * Start authorizing a member's or a service connection. `projectId` is
   * absent for a tenant service connection; `externalUserId` is whoever
   * authorizes (the member, or the administrator for a service).
   */
  beginAuthorization?(args: {
    tenantId: string;
    projectId?: string;
    externalUserId: string;
    /**
     * Whose authority is being authorized: a member's own account or a
     * service connection (ADR 0177). A provider may challenge differently,
     * e.g. GitHub asks a person to sign in but an administrator for an App.
     */
    principal: "member" | "service";
    redirectUri: string;
    state: string;
  }): Promise<{ challenge: AuthorizationChallenge; privateState?: Uint8Array }>;
  completeAuthorization?(args: {
    tenantId: string;
    projectId?: string;
    externalUserId: string;
    principal: "member" | "service";
    callback: Readonly<Record<string, string>>;
    privateState?: Uint8Array;
  }): Promise<ConnectionAuthorizationResult>;
  invoke(args: {
    material: Uint8Array;
    action: string;
    input: Json;
    capabilities: readonly string[];
    /**
     * The connection and credential revision the material belongs to, so a
     * provider can reuse upstream sessions per credential (ADR 0172).
     */
    connection: ConnectionCredentialVersion;
  }): Promise<Json>;
  listActions?(args: {
    material: Uint8Array;
    capabilities: readonly string[];
  }): Promise<readonly ConnectionActionDefinition[]>;
  /**
   * Whether an action only reads (ADR 0176): a read-only agent may call
   * nothing else. Without it, an action's `readOnlyHint` annotation from
   * `listActions` decides, and an action without one counts as a write.
   */
  readOnly?(action: string): boolean;
  refresh?(args: {
    material: Uint8Array;
  }): Promise<ConnectionAuthorizationResult>;
  revoke?(args: { material: Uint8Array }): Promise<void>;
  /**
   * Drop anything held for a connection's earlier credentials (pooled
   * sessions). Called after rotation, refresh, and revocation.
   */
  release?(args: { connectionId: string }): Promise<void>;
}

export interface ConnectionCredentialVersion {
  id: string;
  /** Increments whenever the stored credential changes. */
  revision: number;
}

export class ConnectionProviderRegistry {
  private readonly providers = new Map<string, ConnectionProvider>();

  constructor(providers: readonly ConnectionProvider[] = []) {
    for (const provider of providers) {
      if (!/^[a-z0-9][a-z0-9._-]*$/.test(provider.kind)) {
        throw new Error(`Invalid connection provider kind '${provider.kind}'`);
      }
      if (this.providers.has(provider.kind)) {
        throw new Error(`Duplicate connection provider '${provider.kind}'`);
      }
      this.providers.set(provider.kind, provider);
    }
  }

  get(kind: string): ConnectionProvider | undefined {
    return this.providers.get(kind);
  }

  list(): readonly ConnectionProvider[] {
    return [...this.providers.values()];
  }
}
