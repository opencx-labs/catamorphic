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
  serverKeyOf,
} from "@catamorphic/sandbox";
import { safeStorage } from "electron";

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
  id: string;
  /** Display name; also the basis of the harness-side server key. */
  name: string;
  transport: "http" | "sse" | "stdio";
  url?: string;
  /** Decrypted in memory; never crosses the contextBridge. */
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
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
   * The profile's ceiling for this connection's tools (see
   * @catamorphic/sandbox tool-policy). Absent = `auto`: read-only tools
   * run, the rest ask. Agents can only narrow this.
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
  extends Omit<McpConnection, "headers" | "env" | "oauth"> {
  headersEncrypted?: string;
  headersPlaintext?: Record<string, string>;
  envEncrypted?: string;
  envPlaintext?: Record<string, string>;
  oauthEncrypted?: string;
  oauthPlaintext?: McpOAuthState;
}

interface ConnectionsFile {
  connections: StoredConnection[];
}

/** Connection as exposed to the renderer: secret values never included. */
export interface PublicMcpConnection {
  id: string;
  name: string;
  /** Slug the harnesses use as the tool-name prefix (`<serverKey>/<tool>`). */
  serverKey: string;
  transport: "http" | "sse" | "stdio";
  url?: string;
  command?: string;
  args?: string[];
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
  /** New env map; omit to keep the stored one, null to clear it. */
  env?: Record<string, string> | null;
  enabled?: boolean;
  /** Provisioner-set ceiling; null clears it. */
  ceiling?: McpConnectionCeiling | null;
}

export class ConnectionsStore {
  private data: ConnectionsFile;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly file: string) {
    this.data = this.load();
    this.migratePlaintext();
  }

  private load(): ConnectionsFile {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf-8"));
      if (Array.isArray(raw?.connections)) return raw as ConnectionsFile;
    } catch {
      // First run.
    }
    return { connections: [] };
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

  private migratePlaintext(): void {
    const needsMigration = this.data.connections.some(
      (connection) =>
        connection.headersPlaintext ||
        connection.envPlaintext ||
        connection.oauthPlaintext,
    );
    if (!needsMigration) return;
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error(
        "OS credential encryption is required to migrate connection secrets",
      );
    }
    for (const connection of this.data.connections) {
      if (connection.headersPlaintext) {
        connection.headersEncrypted = encryptValue(connection.headersPlaintext);
        connection.headersPlaintext = undefined;
      }
      if (connection.envPlaintext) {
        connection.envEncrypted = encryptValue(connection.envPlaintext);
        connection.envPlaintext = undefined;
      }
      if (connection.oauthPlaintext) {
        connection.oauthEncrypted = encryptValue(connection.oauthPlaintext);
        connection.oauthPlaintext = undefined;
      }
    }
    this.save();
  }

  /** Fired after every mutation (agent registries key caches off this). */
  onChanged(listener: () => void): void {
    this.listeners.add(listener);
  }

  list(): McpConnection[] {
    return this.data.connections.map((stored) => this.decrypt(stored));
  }

  get(id: string): McpConnection | undefined {
    const stored = this.data.connections.find((entry) => entry.id === id);
    return stored ? this.decrypt(stored) : undefined;
  }

  create(input: CreateConnectionInput): McpConnection {
    const stored: StoredConnection = {
      id: randomUUID(),
      name: input.name.trim() || "Connection",
      transport: input.transport,
      ...(input.url ? { url: input.url } : {}),
      ...(input.command ? { command: input.command } : {}),
      ...(input.args && input.args.length > 0 ? { args: input.args } : {}),
      ...(input.iconUrl ? { iconUrl: input.iconUrl } : {}),
      ...(input.oauthClient ? { oauthClient: input.oauthClient } : {}),
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
    if (patch.name !== undefined)
      stored.name = patch.name.trim() || stored.name;
    if (patch.url !== undefined) stored.url = patch.url;
    if (patch.command !== undefined) stored.command = patch.command;
    if (patch.args !== undefined) stored.args = patch.args;
    if (patch.enabled !== undefined) stored.enabled = patch.enabled;
    if (patch.ceiling !== undefined)
      stored.ceiling = patch.ceiling ?? undefined;
    if (patch.headers !== undefined) {
      const next = encryptMap("headers", patch.headers ?? undefined);
      stored.headersEncrypted = next.headersEncrypted;
      stored.headersPlaintext = next.headersPlaintext;
    }
    if (patch.env !== undefined) {
      const next = encryptMap("env", patch.env ?? undefined);
      stored.envEncrypted = next.envEncrypted;
      stored.envPlaintext = next.envPlaintext;
    }
    this.save();
    return this.decrypt(stored);
  }

  /** The profile's tool policy for a connection (undefined = auto). */
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
  setOAuth(id: string, state: McpOAuthState | undefined): void {
    const stored = this.data.connections.find((entry) => entry.id === id);
    if (!stored) return;
    const next = encryptJson("oauth", state);
    stored.oauthEncrypted = next.oauthEncrypted;
    stored.oauthPlaintext = next.oauthPlaintext;
    this.save();
  }

  remove(id: string): boolean {
    const before = this.data.connections.length;
    this.data.connections = this.data.connections.filter(
      (entry) => entry.id !== id,
    );
    if (this.data.connections.length === before) return false;
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
      this.data.connections = this.data.connections.filter(
        (entry) => !removed.includes(entry.id),
      );
      this.save();
    }
    return removed;
  }

  private decrypt(stored: StoredConnection): McpConnection {
    const {
      headersEncrypted,
      headersPlaintext,
      envEncrypted,
      envPlaintext,
      oauthEncrypted,
      oauthPlaintext,
      ...rest
    } = stored;
    const oauth = decryptJson<McpOAuthState>(oauthEncrypted, oauthPlaintext);
    return {
      ...rest,
      ...maybeMap("headers", headersEncrypted, headersPlaintext),
      ...maybeMap("env", envEncrypted, envPlaintext),
      ...(oauth ? { oauth } : {}),
    };
  }
}

function encryptMap(
  key: "headers" | "env",
  map: Record<string, string> | undefined,
): Partial<StoredConnection> {
  if (!map || Object.keys(map).length === 0) return {};
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("OS credential encryption is unavailable");
  }
  return { [`${key}Encrypted`]: encryptValue(map) };
}

function encryptJson<T>(
  key: "oauth",
  value: T | undefined,
): { oauthEncrypted?: string; oauthPlaintext?: T } {
  if (value === undefined) return {};
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("OS credential encryption is unavailable");
  }
  return { [`${key}Encrypted`]: encryptValue(value) };
}

function encryptValue(value: unknown): string {
  return safeStorage.encryptString(JSON.stringify(value)).toString("base64");
}

function decryptJson<T>(
  encrypted: string | undefined,
  plaintext: T | undefined,
): T | undefined {
  if (encrypted) {
    try {
      return JSON.parse(
        safeStorage.decryptString(Buffer.from(encrypted, "base64")),
      ) as T;
    } catch {
      return undefined;
    }
  }
  return plaintext;
}

function maybeMap(
  key: "headers" | "env",
  encrypted: string | undefined,
  plaintext: Record<string, string> | undefined,
): Partial<Pick<McpConnection, "headers" | "env">> {
  if (encrypted) {
    try {
      return {
        [key]: JSON.parse(
          safeStorage.decryptString(Buffer.from(encrypted, "base64")),
        ) as Record<string, string>,
      };
    } catch {
      return {};
    }
  }
  return plaintext ? { [key]: plaintext } : {};
}

export function toPublicConnection(
  connection: McpConnection,
): PublicMcpConnection {
  const { headers, env, oauth, ...rest } = connection;
  return {
    ...rest,
    serverKey: connectionServerKey(connection),
    headerNames: Object.keys(headers ?? {}),
    envNames: Object.keys(env ?? {}),
    authorized: Boolean(oauth?.tokens?.access_token),
  };
}

/** Connection → the harness-neutral server config every harness consumes. */
export function toAgentMcpServer(
  connection: McpConnection,
): AgentMcpServerConfig | undefined {
  if (connection.transport === "stdio") {
    if (!connection.command) return undefined;
    return {
      transport: "stdio",
      command: connection.command,
      ...(connection.args ? { args: connection.args } : {}),
      ...(connection.env ? { env: connection.env } : {}),
    };
  }
  if (!connection.url) return undefined;
  // OAuth tokens ride as a bearer header: harnesses with their own MCP
  // client (Claude Code, Codex) never learn OAuth exists.
  const headers = { ...connection.headers, ...bearerHeaders(connection.oauth) };
  return {
    transport: connection.transport,
    url: connection.url,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  };
}

/** Stable, TOML/tool-name-safe server key for a connection. */
export function connectionServerKey(connection: McpConnection): string {
  return serverKeyOf(connection.name) || connection.id.slice(0, 8);
}

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
    while (keyed.has(key)) key = `${key}-2`;
    keyed.set(key, connection);
  }
  return keyed;
}
