import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  bearerHeaders,
  type McpOAuthClientHint,
  type McpOAuthState,
  type McpToolAnnotations,
} from "@catamorphic/mcp";
import {
  type AgentMcpServerConfig,
  type McpToolPolicy,
  PROJECT_TOOLS_SERVER_KEY,
  serverKeyOf,
} from "@catamorphic/sandbox";
import { safeStorage } from "electron";
import { z } from "zod";
import type { ProfileConnection } from "../shared/profile-connections.js";
import {
  CredentialStorageError,
  credentialUnlockError,
  requireCredentialEncryption,
} from "./credential-encryption.js";

/**
 * Per-profile MCP connections: `<userData>/profiles/<id>/connections.json`.
 *
 * A connection is one configured MCP server — added by hand, installed
 * from the MCP registry, or lifted out of a connector plugin. Connections
 * belong to the profile; each agent then gets all of them or a picked
 * subset (see the agent's `connections` setting). Header and env values
 * routinely carry tokens, so both maps are encrypted at rest via
 * safeStorage and never cross the contextBridge — the renderer sees key
 * names only.
 */

export type ConnectionSource =
  | { kind: "manual" }
  | { kind: "registry"; registryName: string }
  | { kind: "plugin"; plugin: string };

export interface McpConnection {
  /** The saved credentials are unavailable; no transport may use this record. */
  credentialError?: string;
  /** Authorize can replace unreadable OAuth state after other credentials unlock. */
  oauthRecoveryRequired?: boolean;
  id: string;
  /** Display name; also the basis of the harness-side server key. */
  name: string;
  transport: "http" | "sse" | "stdio";
  url?: string;
  /** Decrypted in memory; never crosses the contextBridge. */
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
  cwd?: string;
  envVars?: string[];
  /** Decrypted in memory; never crosses the contextBridge. */
  env?: Record<string, string>;
  enabled: boolean;
  source: ConnectionSource;
  /** Display icon (https/data url), e.g. from the registry entry. */
  iconUrl?: string;
  /**
   * OAuth state for remote servers that demanded it (client registration,
   * tokens, discovery). Decrypted in memory; never crosses the
   * contextBridge — the renderer only learns whether tokens exist.
   */
  oauth?: McpOAuthState;
  /** Pre-registered OAuth client the source (plugin) declared, if any. */
  oauthClient?: McpOAuthClientHint;
  /**
   * The profile's explicit policy for this connection's tools (see
   * @catamorphic/sandbox tool-policy). Absent follows the agent's sandboxing: publish
   * allows tools, contained and propose use auto. Explicit policies only narrow this.
   */
  toolPolicy?: McpToolPolicy;
  /**
   * A ceiling set by whoever provisioned the connection on the user's
   * behalf — an organization sharing a service credential through a
   * remote instance. Layer zero: the user's own `toolPolicy` and any
   * agent's policy sit under it and can only narrow further. Read-only in
   * the editors, shown as "Set by <source>".
   */
  ceiling?: McpConnectionCeiling;
  /** Tools last seen on the server (name/description/annotations) — what
   * the permission editor lists and what `auto` reads for harnesses that
   * can't see annotations at call time. */
  tools?: CachedMcpTool[];
}

export interface McpConnectionCeiling {
  policy: McpToolPolicy;
  /** Who set it, for the UI ("Acme Corp"). */
  source: string;
}

export interface CachedMcpTool {
  name: string;
  description: string;
  annotations?: McpToolAnnotations;
}

interface StoredConnection
  extends Omit<
    McpConnection,
    | "headers"
    | "env"
    | "oauth"
    | "oauthClient"
    | "credentialError"
    | "oauthRecoveryRequired"
  > {
  headersEncrypted?: string;
  envEncrypted?: string;
  oauthEncrypted?: string;
  oauthClientEncrypted?: string;
}

interface ConnectionsFile {
  connections: StoredConnection[];
}

const STORED_CONNECTION_FIELDS: Record<keyof StoredConnection, true> = {
  id: true,
  name: true,
  transport: true,
  url: true,
  command: true,
  args: true,
  cwd: true,
  envVars: true,
  enabled: true,
  source: true,
  iconUrl: true,
  toolPolicy: true,
  ceiling: true,
  tools: true,
  headersEncrypted: true,
  envEncrypted: true,
  oauthEncrypted: true,
  oauthClientEncrypted: true,
};

/** Connection as exposed to the renderer: secret values never included. */
export interface PublicMcpConnection {
  authorizationError?: string;
  id: string;
  name: string;
  /** Slug the harnesses use as the tool-name prefix (`<serverKey>/<tool>`). */
  serverKey: string;
  transport: "http" | "sse" | "stdio";
  url?: string;
  command?: string;
  args?: string[];
  cwd?: string;
  envVars?: string[];
  headerNames: string[];
  envNames: string[];
  enabled: boolean;
  source: ConnectionSource;
  iconUrl?: string;
  /** Set once the connection has been through OAuth (tokens on file). */
  authorized: boolean;
  toolPolicy?: McpToolPolicy;
  ceiling?: McpConnectionCeiling;
  tools?: CachedMcpTool[];
}

export interface CreateConnectionInput {
  name: string;
  transport: "http" | "sse" | "stdio";
  url?: string;
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
  cwd?: string;
  envVars?: string[];
  env?: Record<string, string>;
  enabled?: boolean;
  source?: ConnectionSource;
  iconUrl?: string;
  oauthClient?: McpOAuthClientHint;
  ceiling?: McpConnectionCeiling;
}

export interface UpdateConnectionInput {
  name?: string;
  url?: string;
  /** New header map; omit to keep the stored one, null to clear it. */
  headers?: Record<string, string> | null;
  command?: string;
  args?: string[];
  cwd?: string | null;
  envVars?: string[];
  oauthClient?: McpOAuthClientHint | null;
  /** New env map; omit to keep the stored one, null to clear it. */
  env?: Record<string, string> | null;
  enabled?: boolean;
  /** Provisioner-set ceiling; null clears it. */
  ceiling?: McpConnectionCeiling | null;
}

export class ConnectionsStore {
  private data: ConnectionsFile;
  private readonly listeners = new Set<() => void>();
  private readonly securityRevisions = new Map<string, number>();

  constructor(private readonly file: string) {
    this.data = this.load();
  }

  /**
   * A profile's connections as its preview card shows them, read from its
   * file without decrypting or watching it: the card reads
   * profiles that are not open.
   */
  static previews(file: string): ProfileConnection[] {
    try {
      const raw: { connections?: Partial<StoredConnection>[] } = JSON.parse(
        fs.readFileSync(file, "utf-8"),
      );
      return (raw.connections ?? []).flatMap((connection) =>
        typeof connection.name === "string"
          ? [
              {
                name: connection.name,
                ...(connection.iconUrl ? { iconUrl: connection.iconUrl } : {}),
                ...(connection.transport !== "stdio" && connection.url
                  ? { url: connection.url }
                  : {}),
              },
            ]
          : [],
      );
    } catch {
      return [];
    }
  }

  private load(): ConnectionsFile {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf-8"));
      if (!Array.isArray(raw?.connections))
        throw new Error("Invalid connection settings");
      if (
        Object.keys(raw).some((key) => key !== "connections") ||
        raw.connections.some(
          (entry: unknown) =>
            entry === null ||
            typeof entry !== "object" ||
            Array.isArray(entry) ||
            Object.keys(entry).some(
              (key) => !Object.hasOwn(STORED_CONNECTION_FIELDS, key),
            ),
        )
      )
        throw new Error("Unsupported connection settings");
      return raw as ConnectionsFile;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return { connections: [] };
      throw new Error("Connection settings could not be opened", {
        cause: error,
      });
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(this.data, null, 2)}\n`, {
      mode: 0o600,
    });
    fs.renameSync(temporary, this.file);
    fs.chmodSync(this.file, 0o600);
    for (const listener of this.listeners) listener();
  }

  /** Fired after every mutation (agent registries key caches off this). */
  onChanged(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Process-local account/config epoch; mounted views never survive a restart. */
  securityRevision(id: string): number {
    return this.securityRevisions.get(id) ?? 0;
  }

  private invalidateSecurity(id: string): void {
    this.securityRevisions.set(id, this.securityRevision(id) + 1);
  }

  list(): McpConnection[] {
    return this.data.connections.map((stored) => this.decrypt(stored));
  }

  get(id: string): McpConnection | undefined {
    const stored = this.data.connections.find((entry) => entry.id === id);
    return stored ? this.decrypt(stored) : undefined;
  }

  /** Only the person's explicit Authorize action may discard unreadable OAuth. */
  getForAuthorization(id: string): McpConnection | undefined {
    const stored = this.data.connections.find((entry) => entry.id === id);
    if (!stored) return undefined;
    requireCredentialEncryption();
    return this.decrypt(stored, { allowOAuthRecovery: true });
  }

  create(input: CreateConnectionInput): McpConnection {
    const stored: StoredConnection = {
      id: randomUUID(),
      name: input.name.trim() || "Connection",
      transport: input.transport,
      ...(input.url ? { url: input.url } : {}),
      ...(input.command ? { command: input.command } : {}),
      ...(input.args && input.args.length > 0 ? { args: input.args } : {}),
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(input.envVars ? { envVars: input.envVars } : {}),
      ...(input.iconUrl ? { iconUrl: input.iconUrl } : {}),
      ...encryptJson("oauthClient", input.oauthClient),
      ...(input.ceiling ? { ceiling: input.ceiling } : {}),
      enabled: input.enabled ?? true,
      source: input.source ?? { kind: "manual" },
      ...encryptMap("headers", input.headers),
      ...encryptMap("env", input.env),
    };
    this.data.connections.push(stored);
    this.save();
    return this.decrypt(stored);
  }

  update(id: string, patch: UpdateConnectionInput): McpConnection | undefined {
    const stored = this.data.connections.find((entry) => entry.id === id);
    if (!stored) return undefined;
    const previousSecurity = connectionSecurityConfig(stored);
    const headers =
      patch.headers === undefined
        ? undefined
        : encryptMap(
            "headers",
            patch.headers ?? undefined,
            stored.headersEncrypted,
          );
    const env =
      patch.env === undefined
        ? undefined
        : encryptMap("env", patch.env ?? undefined, stored.envEncrypted);
    const oauthClient =
      patch.oauthClient === undefined
        ? undefined
        : encryptJson(
            "oauthClient",
            patch.oauthClient ?? undefined,
            stored.oauthClientEncrypted,
          );
    if (patch.name !== undefined)
      stored.name = patch.name.trim() || stored.name;
    if (patch.url !== undefined) stored.url = patch.url;
    if (patch.command !== undefined) stored.command = patch.command;
    if (patch.args !== undefined) stored.args = patch.args;
    if (patch.cwd !== undefined) stored.cwd = patch.cwd ?? undefined;
    if (patch.envVars !== undefined) stored.envVars = patch.envVars;
    if (oauthClient)
      stored.oauthClientEncrypted = oauthClient.oauthClientEncrypted;
    if (patch.enabled !== undefined) stored.enabled = patch.enabled;
    if (patch.ceiling !== undefined)
      stored.ceiling = patch.ceiling ?? undefined;
    if (headers) stored.headersEncrypted = headers.headersEncrypted;
    if (env) stored.envEncrypted = env.envEncrypted;
    if (connectionSecurityConfig(stored) !== previousSecurity)
      this.invalidateSecurity(id);
    this.save();
    return this.decrypt(stored);
  }

  /** The profile's tool policy for a connection (undefined follows the agent mode). */
  setToolPolicy(id: string, policy: McpToolPolicy | undefined): void {
    const stored = this.data.connections.find((entry) => entry.id === id);
    if (!stored) return;
    if (policy && (policy.default || Object.keys(policy.tools ?? {}).length)) {
      stored.toolPolicy = policy;
    } else {
      stored.toolPolicy = undefined;
    }
    this.save();
  }

  /** One rule, in place: what "Always allow" writes. */
  setToolPermission(
    id: string,
    tool: string,
    permission: "allow" | "ask" | "deny",
  ): void {
    const stored = this.data.connections.find((entry) => entry.id === id);
    if (!stored) return;
    stored.toolPolicy = {
      ...stored.toolPolicy,
      tools: { ...stored.toolPolicy?.tools, [tool]: permission },
    };
    this.save();
  }

  /** Remember the server's tool roster (from a probe/authorize). */
  setTools(id: string, tools: CachedMcpTool[]): void {
    const stored = this.data.connections.find((entry) => entry.id === id);
    if (!stored) return;
    stored.tools = tools;
    this.save();
  }

  /** Replace the OAuth state (called from the provider on every step of a
   * flow — registration, verifier, tokens — and by the refresher). */
  setOAuth(
    id: string,
    state: McpOAuthState | undefined,
    options:
      | { refresh?: false; securityRevision?: number }
      | { refresh: true; securityRevision: number } = {},
  ): number | undefined {
    if (
      options.securityRevision !== undefined &&
      options.securityRevision !== this.securityRevision(id)
    )
      throw new Error(
        options.refresh
          ? "The connection authorization changed during token renewal"
          : "The connection authorization changed during authorization",
      );
    const stored = this.data.connections.find((entry) => entry.id === id);
    if (!stored) return;
    const next = encryptJson("oauth", state);
    stored.oauthEncrypted = next.oauthEncrypted;
    if (!options.refresh) this.invalidateSecurity(id);
    const revision = this.securityRevision(id);
    this.save();
    return revision;
  }

  remove(id: string): boolean {
    const before = this.data.connections.length;
    this.data.connections = this.data.connections.filter(
      (entry) => entry.id !== id,
    );
    if (this.data.connections.length === before) return false;
    this.invalidateSecurity(id);
    this.save();
    return true;
  }

  /** Remove every connection a given plugin installed. */
  removeForPlugin(plugin: string): string[] {
    const removed = this.data.connections
      .filter(
        (entry) =>
          entry.source.kind === "plugin" && entry.source.plugin === plugin,
      )
      .map((entry) => entry.id);
    if (removed.length > 0) {
      for (const id of removed) this.invalidateSecurity(id);
      this.data.connections = this.data.connections.filter(
        (entry) => !removed.includes(entry.id),
      );
      this.save();
    }
    return removed;
  }

  private decrypt(
    stored: StoredConnection,
    options: { allowOAuthRecovery?: boolean } = {},
  ): McpConnection {
    const {
      headersEncrypted,
      envEncrypted,
      oauthEncrypted,
      oauthClientEncrypted,
      ...rest
    } = stored;
    try {
      const oauthClient = decryptJson(oauthClientEncrypted, OAuthClientSchema);
      const credentials = {
        ...rest,
        ...maybeMap("headers", headersEncrypted),
        ...maybeMap("env", envEncrypted),
        ...(oauthClient ? { oauthClient } : {}),
      };
      try {
        const oauth = decryptJson(oauthEncrypted, OAuthStateSchema);
        return { ...credentials, ...(oauth ? { oauth } : {}) };
      } catch (cause) {
        return options.allowOAuthRecovery
          ? { ...credentials, oauthRecoveryRequired: true }
          : {
              ...rest,
              credentialError:
                cause instanceof CredentialStorageError
                  ? cause.message
                  : credentialUnlockError({ cause }).message,
              oauthRecoveryRequired: true,
            };
      }
    } catch (cause) {
      return {
        ...rest,
        credentialError:
          cause instanceof CredentialStorageError
            ? cause.message
            : credentialUnlockError({ cause }).message,
      };
    }
  }
}

/** Explicit connection edits, excluding labels, permissions and cached rosters. */
function connectionSecurityConfig(connection: StoredConnection): string {
  return stableValue({
    transport: connection.transport,
    url: connection.url,
    command: connection.command,
    args: connection.args,
    cwd: connection.cwd,
    envVars: connection.envVars,
    headers: connection.headersEncrypted,
    env: connection.envEncrypted,
    oauthClient: connection.oauthClientEncrypted,
    enabled: connection.enabled,
  });
}

function stableValue(value: unknown): string {
  return (
    JSON.stringify(value, (_key, value: unknown) =>
      value !== null && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(
            Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
          )
        : value,
    ) ?? "undefined"
  );
}

function encryptMap(
  key: "headers" | "env",
  map: Record<string, string> | undefined,
  previousEncrypted?: string,
): Partial<StoredConnection> {
  if (!map || Object.keys(map).length === 0) return {};
  requireCredentialEncryption();
  return {
    [`${key}Encrypted`]: reusableCiphertext(
      previousEncrypted,
      map,
      StringMapSchema,
    )
      ? previousEncrypted
      : encryptValue(map),
  };
}

function encryptJson<T>(
  key: "oauth" | "oauthClient",
  value: T | undefined,
  previousEncrypted?: string,
): Pick<Partial<StoredConnection>, "oauthEncrypted" | "oauthClientEncrypted"> {
  if (value === undefined) return {};
  requireCredentialEncryption();
  return {
    [`${key}Encrypted`]: reusableCiphertext(
      previousEncrypted,
      value,
      key === "oauthClient" ? OAuthClientSchema : OAuthStateSchema,
    )
      ? previousEncrypted
      : encryptValue(value),
  };
}

/** A readable equivalent edit keeps its ciphertext and mounted account epoch. */
function reusableCiphertext(
  encrypted: string | undefined,
  value: unknown,
  schema: z.ZodType,
): boolean {
  if (encrypted === undefined) return false;
  try {
    return stableValue(decryptJson(encrypted, schema)) === stableValue(value);
  } catch {
    // Explicit replacement is still allowed when the old value cannot be unlocked.
    return false;
  }
}

function encryptValue(value: unknown): string {
  try {
    return safeStorage.encryptString(JSON.stringify(value)).toString("base64");
  } catch (cause) {
    throw credentialUnlockError({ cause });
  }
}

const StringMapSchema = z.record(z.string(), z.string());
const OAuthClientSchema = z.strictObject({
  clientId: z.string().min(1),
  clientSecret: z.string().optional(),
  callbackPort: z.number().int().min(1).max(65535).optional(),
  scopes: z.array(z.string()).optional(),
}) satisfies z.ZodType<McpOAuthClientHint>;
const OAuthStateValidation = z.strictObject({
  clientInformation: z
    .object({
      client_id: z.string().min(1),
      client_secret: z.string().optional(),
    })
    .passthrough()
    .optional(),
  tokens: z
    .object({
      access_token: z.string().min(1),
      token_type: z.string().min(1),
      refresh_token: z.string().optional(),
      scope: z.string().optional(),
      expires_in: z.number().optional(),
    })
    .passthrough()
    .optional(),
  tokensObtainedAt: z.number().optional(),
  discovery: z.record(z.string(), z.unknown()).optional(),
  codeVerifier: z.string().optional(),
});
const OAuthStateSchema = z.custom<McpOAuthState>(
  (value) => OAuthStateValidation.safeParse(value).success,
);

function decryptJson<T>(
  encrypted: string | undefined,
  schema: z.ZodType<T>,
): T | undefined {
  if (encrypted !== undefined) {
    requireCredentialEncryption();
    try {
      return schema.parse(
        JSON.parse(safeStorage.decryptString(Buffer.from(encrypted, "base64"))),
      );
    } catch (cause) {
      throw credentialUnlockError({ cause });
    }
  }
  return undefined;
}

function maybeMap(
  key: "headers" | "env",
  encrypted: string | undefined,
): Partial<Pick<McpConnection, "headers" | "env">> {
  const value = decryptJson(encrypted, StringMapSchema);
  return value === undefined ? {} : { [key]: value };
}

export function toPublicConnection(
  connection: McpConnection,
): PublicMcpConnection {
  const { headers, env, oauth } = connection;
  return {
    id: connection.id,
    name: connection.name,
    transport: connection.transport,
    ...(connection.url ? { url: connection.url } : {}),
    ...(connection.command ? { command: connection.command } : {}),
    ...(connection.args ? { args: connection.args } : {}),
    ...(connection.cwd ? { cwd: connection.cwd } : {}),
    ...(connection.envVars ? { envVars: connection.envVars } : {}),
    enabled: connection.enabled,
    source: connection.source,
    ...(connection.iconUrl ? { iconUrl: connection.iconUrl } : {}),
    ...(connection.toolPolicy ? { toolPolicy: connection.toolPolicy } : {}),
    ...(connection.ceiling ? { ceiling: connection.ceiling } : {}),
    ...(connection.tools ? { tools: connection.tools } : {}),
    serverKey: connectionServerKey(connection),
    headerNames: Object.keys(headers ?? {}),
    envNames: Object.keys(env ?? {}),
    authorized: Boolean(oauth?.tokens?.access_token),
    ...(connectionAuthorizationError(connection)
      ? { authorizationError: connectionAuthorizationError(connection) }
      : {}),
  };
}

/** Connection → the harness-neutral server config every harness consumes. */
export function toAgentMcpServer(
  connection: McpConnection,
): AgentMcpServerConfig | undefined {
  if (connectionAuthorizationError(connection)) return undefined;
  const expand = (value: string) => expandConnectionValue(value, connection);
  if (connection.transport === "stdio") {
    if (!connection.command) return undefined;
    return {
      transport: "stdio",
      command: expand(connection.command),
      ...(connection.args ? { args: connection.args.map(expand) } : {}),
      ...(connection.env
        ? {
            env: Object.fromEntries(
              Object.entries(connection.env).map(([key, value]) => [
                key,
                expand(value),
              ]),
            ),
          }
        : {}),
      ...(connection.cwd ? { cwd: connection.cwd } : {}),
      ...(connection.envVars ? { envVars: connection.envVars } : {}),
    };
  }
  if (!connection.url) return undefined;
  // OAuth tokens ride as a bearer header: harnesses with their own MCP
  // client (Claude Code, Codex) never learn OAuth exists.
  const headers = Object.fromEntries(
    Object.entries(effectiveConnectionHeaders(connection)).map(
      ([key, value]) => [key, expand(value)],
    ),
  );
  return {
    transport: connection.transport,
    url: expand(connection.url),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  };
}

function effectiveConnectionHeaders(connection: McpConnection) {
  const oauth = bearerHeaders(connection.oauth);
  return {
    ...Object.fromEntries(
      Object.entries(connection.headers ?? {}).filter(
        ([key]) =>
          !oauth.Authorization || key.toLowerCase() !== "authorization",
      ),
    ),
    ...oauth,
  };
}

function expandConnectionValue(
  value: string,
  connection: McpConnection,
): string {
  return value.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g,
    (_match, name: string, fallback: string | undefined) => {
      const replacement =
        connection.env?.[name] ?? process.env[name] ?? fallback;
      return replacement && !replacement.includes("${")
        ? replacement
        : `\${${name}}`;
    },
  );
}

/** Missing configuration is reported by name, never by credential value. */
export function connectionAuthorizationError(
  connection: McpConnection,
): string | undefined {
  if (connection.credentialError) return connection.credentialError;
  if (connection.oauthRecoveryRequired)
    return "Authorize this connection again to replace its unreadable saved sign-in.";
  const values =
    connection.transport === "stdio"
      ? [
          connection.command ?? "",
          ...(connection.args ?? []),
          ...Object.values(connection.env ?? {}),
        ]
      : [
          connection.url ?? "",
          ...Object.values(effectiveConnectionHeaders(connection)),
        ];
  const missing = new Set(
    values.flatMap((value) =>
      [
        ...expandConnectionValue(value, connection).matchAll(
          /\$\{([A-Za-z_][A-Za-z0-9_]*)[^}]*\}/g,
        ),
      ].map((match) => match[1]),
    ),
  );
  return missing.size
    ? `Authorization required: configure ${[...missing].join(", ")} in this connection.`
    : undefined;
}

/** Stable, TOML/tool-name-safe server key for a connection. */
export function connectionServerKey(connection: McpConnection): string {
  return serverKeyOf(connection.name) || connection.id.slice(0, 8);
}

/**
 * MCP server names the host's own tools take beside connectors (the
 * workspace tools, the project's workflow tools): a connector mounted as
 * its own server (ADR 0225) must never shadow one, or be shadowed.
 */
const HOST_SERVER_KEYS = new Set(["workspace", PROJECT_TOOLS_SERVER_KEY]);

/**
 * Server key → connection for every ENABLED connection, with duplicate
 * names deduped deterministically. Computed over the full enabled set so
 * a key means the same connection everywhere (harness config, event
 * names, the MCP-apps view resolver) regardless of per-agent narrowing.
 */
export function connectionServerKeys(
  connections: McpConnection[],
): Map<string, McpConnection> {
  const keyed = new Map<string, McpConnection>();
  for (const connection of connections) {
    if (!connection.enabled) continue;
    let key = connectionServerKey(connection);
    while (keyed.has(key) || HOST_SERVER_KEYS.has(key)) key = `${key}-2`;
    keyed.set(key, connection);
  }
  return keyed;
}
