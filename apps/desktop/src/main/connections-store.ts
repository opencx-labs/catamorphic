import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AgentMcpServerConfig } from "@catamorphic/sandbox";
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
}

interface StoredConnection extends Omit<McpConnection, "headers" | "env"> {
  headersEncrypted?: string;
  headersPlaintext?: Record<string, string>;
  envEncrypted?: string;
  envPlaintext?: Record<string, string>;
}

interface ConnectionsFile {
  connections: StoredConnection[];
}

/** Connection as exposed to the renderer: secret values never included. */
export interface PublicMcpConnection {
  id: string;
  name: string;
  transport: "http" | "sse" | "stdio";
  url?: string;
  command?: string;
  args?: string[];
  headerNames: string[];
  envNames: string[];
  enabled: boolean;
  source: ConnectionSource;
  iconUrl?: string;
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
}

export class ConnectionsStore {
  private data: ConnectionsFile;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly file: string) {
    this.data = this.load();
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
    fs.writeFileSync(this.file, `${JSON.stringify(this.data, null, 2)}\n`, {
      mode: 0o600,
    });
    for (const listener of this.listeners) listener();
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
      ...rest
    } = stored;
    return {
      ...rest,
      ...maybeMap("headers", headersEncrypted, headersPlaintext),
      ...maybeMap("env", envEncrypted, envPlaintext),
    };
  }
}

function encryptMap(
  key: "headers" | "env",
  map: Record<string, string> | undefined,
): Partial<StoredConnection> {
  if (!map || Object.keys(map).length === 0) return {};
  if (safeStorage.isEncryptionAvailable()) {
    return {
      [`${key}Encrypted`]: safeStorage
        .encryptString(JSON.stringify(map))
        .toString("base64"),
    };
  }
  console.warn(
    "[desktop] OS keychain encryption unavailable; storing connection secrets in plaintext.",
  );
  return { [`${key}Plaintext`]: map };
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
  const { headers, env, ...rest } = connection;
  return {
    ...rest,
    headerNames: Object.keys(headers ?? {}),
    envNames: Object.keys(env ?? {}),
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
  return {
    transport: connection.transport,
    url: connection.url,
    ...(connection.headers ? { headers: connection.headers } : {}),
  };
}

/** Stable, TOML/tool-name-safe server key for a connection. */
export function connectionServerKey(connection: McpConnection): string {
  const base = connection.name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || connection.id.slice(0, 8);
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
