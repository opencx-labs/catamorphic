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

export interface ConnectionProvider {
  readonly kind: string;
  readonly displayName: string;
  beginAuthorization?(args: {
    tenantId: string;
    projectId: string;
    externalUserId: string;
    redirectUri: string;
    state: string;
  }): Promise<{ challenge: AuthorizationChallenge; privateState?: Uint8Array }>;
  completeAuthorization?(args: {
    tenantId: string;
    projectId: string;
    externalUserId: string;
    callback: Readonly<Record<string, string>>;
    privateState?: Uint8Array;
  }): Promise<ConnectionAuthorizationResult>;
  invoke(args: {
    material: Uint8Array;
    action: string;
    input: Json;
    capabilities: readonly string[];
  }): Promise<Json>;
  listActions?(args: {
    material: Uint8Array;
    capabilities: readonly string[];
  }): Promise<readonly ConnectionActionDefinition[]>;
  refresh?(args: {
    material: Uint8Array;
  }): Promise<ConnectionAuthorizationResult>;
  revoke?(args: { material: Uint8Array }): Promise<void>;
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
