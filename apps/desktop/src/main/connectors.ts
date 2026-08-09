import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_MARKETPLACES,
  fetchMarketplace,
  installPluginFromSource,
  type MarketplacePluginEntry,
  type McpRegistryEntry,
  probeMcpServer,
  readInstalledPlugin,
  searchMcpRegistry,
} from "@catamorphic/mcp";
import type { AgentMcpServerConfig } from "@catamorphic/sandbox";
import type {
  ConnectionsStore,
  McpConnection,
  PublicMcpConnection,
} from "./connections-store.js";
import { toPublicConnection } from "./connections-store.js";

/**
 * Connectors: the user-facing install layer over two open ecosystems —
 * the official MCP Registry (harness-neutral MCP servers) and Claude
 * Code / Cowork plugin marketplaces (skills/agents/commands + MCP
 * servers, same public format Cowork ships).
 *
 * A connector is not tied to one harness. Installing one always lands as
 * profile-level MCP connections every harness consumes; a plugin
 * connector's directory is additionally loaded natively by Claude Code
 * agents (with plugin MCP discovery off — the lifted connections are the
 * single source of truth).
 */

export interface InstalledConnector {
  /** Plugin name, unique per profile. */
  name: string;
  description: string;
  version?: string;
  marketplace: string;
  /** Absolute path of the installed plugin directory. */
  path: string;
  /** Connection ids lifted out of the plugin's MCP declarations. */
  connectionIds: string[];
}

interface ConnectorsFile {
  installed: InstalledConnector[];
  /** Extra plugin marketplaces the user added ("owner/repo" or URLs). */
  marketplaces?: string[];
}

export interface ConnectorSearchResult {
  registry: Array<
    Omit<McpRegistryEntry, "suggested"> & {
      suggested?: {
        transport: string;
        /** Names of secrets/values the user must supply before install. */
        inputs: Array<{
          name: string;
          kind: "header" | "env";
          description?: string;
          required: boolean;
          secret: boolean;
        }>;
      };
    }
  >;
  plugins: Array<{
    name: string;
    description: string;
    version?: string;
    marketplace: string;
    installed: boolean;
  }>;
}

export class ConnectorsService {
  private readonly registryEntries = new Map<string, McpRegistryEntry>();
  private readonly pluginEntries = new Map<string, MarketplacePluginEntry>();

  constructor(
    private readonly deps: {
      /** Directory holding installed plugin dirs for a profile. */
      connectorsDirFor(profileId: string): string;
      connectionsFor(profileId: string): ConnectionsStore;
    },
  ) {}

  private file(profileId: string): string {
    return path.join(this.deps.connectorsDirFor(profileId), "connectors.json");
  }

  private load(profileId: string): ConnectorsFile {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file(profileId), "utf-8"));
      if (Array.isArray(raw?.installed)) return raw as ConnectorsFile;
    } catch {
      // First run.
    }
    return { installed: [] };
  }

  private save(profileId: string, data: ConnectorsFile): void {
    const file = this.file(profileId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  }

  listInstalled(profileId: string): InstalledConnector[] {
    return this.load(profileId).installed;
  }

  marketplaces(profileId: string): string[] {
    return [
      ...DEFAULT_MARKETPLACES,
      ...(this.load(profileId).marketplaces ?? []),
    ];
  }

  addMarketplace(profileId: string, ref: string): void {
    const data = this.load(profileId);
    const extra = data.marketplaces ?? [];
    if (!extra.includes(ref) && !DEFAULT_MARKETPLACES.includes(ref)) {
      data.marketplaces = [...extra, ref];
      this.save(profileId, data);
    }
  }

  /**
   * One search box, two ecosystems: the MCP registry's substring search
   * plus a local filter over every configured plugin marketplace. Either
   * side failing (offline, rate limits) degrades to the other.
   */
  async search(
    profileId: string,
    query: string,
  ): Promise<ConnectorSearchResult> {
    const installed = new Set(
      this.listInstalled(profileId).map((connector) => connector.name),
    );
    const [registry, plugins] = await Promise.all([
      searchMcpRegistry(query, { limit: 20 }).catch(() => []),
      this.searchMarketplaces(profileId, query),
    ]);
    for (const entry of registry) this.registryEntries.set(entry.name, entry);
    for (const entry of plugins) {
      this.pluginEntries.set(`${entry.marketplace}#${entry.name}`, entry);
    }
    return {
      registry: registry.map((entry) => ({
        ...entry,
        suggested: entry.suggested
          ? {
              transport: entry.suggested.config.transport,
              inputs: entry.suggested.inputs,
            }
          : undefined,
      })),
      plugins: plugins.map((entry) => ({
        name: entry.name,
        description: entry.description,
        version: entry.version,
        marketplace: entry.marketplace,
        installed: installed.has(entry.name),
      })),
    };
  }

  private async searchMarketplaces(
    profileId: string,
    query: string,
  ): Promise<MarketplacePluginEntry[]> {
    const needle = query.trim().toLowerCase();
    const lists = await Promise.all(
      this.marketplaces(profileId).map((ref) =>
        fetchMarketplace(ref).catch(() => [] as MarketplacePluginEntry[]),
      ),
    );
    const entries = lists.flat();
    if (!needle) return entries.slice(0, 20);
    return entries
      .filter(
        (entry) =>
          entry.name.toLowerCase().includes(needle) ||
          entry.description.toLowerCase().includes(needle),
      )
      .slice(0, 20);
  }

  /**
   * Install a registry server as a profile connection. `secrets` fills the
   * placeholders the search result asked for (header/env values).
   */
  async installRegistryServer(
    profileId: string,
    registryName: string,
    secrets: Record<string, string>,
  ): Promise<PublicMcpConnection> {
    const entry = this.registryEntries.get(registryName);
    if (!entry?.suggested) {
      throw new Error(`No installable configuration for ${registryName}`);
    }
    const config = structuredClone(entry.suggested.config);
    for (const input of entry.suggested.inputs) {
      const value = secrets[input.name];
      if (!value) {
        if (input.required) throw new Error(`Missing value for ${input.name}`);
        continue;
      }
      if (input.kind === "header" && config.transport !== "stdio") {
        config.headers = { ...config.headers, [input.name]: value };
      }
      if (input.kind === "env" && config.transport === "stdio") {
        config.env = { ...config.env, [input.name]: value };
      }
    }
    const connection = this.deps.connectionsFor(profileId).create({
      name: entry.displayName,
      transport: config.transport,
      ...(config.transport === "stdio"
        ? { command: config.command, args: config.args, env: config.env }
        : { url: config.url, headers: config.headers }),
      ...(entry.iconUrl ? { iconUrl: entry.iconUrl } : {}),
      source: { kind: "registry", registryName },
    });
    return toPublicConnection(connection);
  }

  /** Install a marketplace plugin: clone, lift MCP servers, record it. */
  async installPlugin(
    profileId: string,
    marketplace: string,
    pluginName: string,
  ): Promise<InstalledConnector> {
    const entry = this.pluginEntries.get(`${marketplace}#${pluginName}`);
    if (!entry) {
      throw new Error(
        `Plugin ${pluginName} is not in the last search results — search again.`,
      );
    }
    const targetDir = path.join(
      this.deps.connectorsDirFor(profileId),
      sanitizeDirName(pluginName),
    );
    await installPluginFromSource(entry.source, targetDir);
    const info = await readInstalledPlugin(targetDir).catch(() => ({
      name: pluginName,
      description: entry.description,
      version: entry.version,
      mcpServers: {} as Record<string, AgentMcpServerConfig>,
    }));

    const connections = this.deps.connectionsFor(profileId);
    // Reinstall replaces the plugin's previous connections wholesale.
    connections.removeForPlugin(pluginName);
    const connectionIds: string[] = [];
    for (const [serverName, config] of Object.entries(info.mcpServers)) {
      const connection = connections.create({
        name: serverName,
        transport: config.transport,
        ...(config.transport === "stdio"
          ? { command: config.command, args: config.args, env: config.env }
          : { url: config.url, headers: config.headers }),
        source: { kind: "plugin", plugin: pluginName },
      });
      connectionIds.push(connection.id);
    }

    const installed: InstalledConnector = {
      name: pluginName,
      description: info.description || entry.description,
      version: info.version ?? entry.version,
      marketplace,
      path: targetDir,
      connectionIds,
    };
    const data = this.load(profileId);
    data.installed = [
      ...data.installed.filter((connector) => connector.name !== pluginName),
      installed,
    ];
    this.save(profileId, data);
    return installed;
  }

  async removeConnector(profileId: string, name: string): Promise<boolean> {
    const data = this.load(profileId);
    const connector = data.installed.find((entry) => entry.name === name);
    if (!connector) return false;
    data.installed = data.installed.filter((entry) => entry.name !== name);
    this.save(profileId, data);
    this.deps.connectionsFor(profileId).removeForPlugin(name);
    await fs.promises
      .rm(connector.path, { recursive: true, force: true })
      .catch(() => {});
    return true;
  }

  /** Probe a stored connection (connect, list tools, close). */
  async probeConnection(profileId: string, connectionId: string) {
    const connection = this.deps.connectionsFor(profileId).get(connectionId);
    if (!connection) return { ok: false, error: "Connection not found" };
    const config = connectionToConfig(connection);
    if (!config) return { ok: false, error: "Connection is incomplete" };
    return probeMcpServer(config);
  }
}

function connectionToConfig(
  connection: McpConnection,
): AgentMcpServerConfig | undefined {
  if (connection.transport === "stdio") {
    return connection.command
      ? {
          transport: "stdio",
          command: connection.command,
          args: connection.args,
          env: connection.env,
        }
      : undefined;
  }
  return connection.url
    ? {
        transport: connection.transport,
        url: connection.url,
        headers: connection.headers,
      }
    : undefined;
}

function sanitizeDirName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, "-");
}
