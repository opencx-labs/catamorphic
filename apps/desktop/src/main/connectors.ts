import fs from "node:fs";
import path from "node:path";
import {
  authorizeMcpServer,
  DEFAULT_MARKETPLACES,
  fetchMarketplace,
  installPluginFromSource,
  isAuthorizationError,
  type MarketplacePluginEntry,
  type McpConnectionProbe,
  type McpOAuthClientHint,
  type McpOAuthStore,
  type McpRegistryEntry,
  probeMcpServer,
  readInstalledPlugin,
  refreshMcpTokens,
  searchMcpRegistry,
} from "@catamorphic/mcp";
import type { AgentMcpServerConfig } from "@catamorphic/sandbox";
import type {
  ConnectionsStore,
  McpConnection,
  PublicMcpConnection,
} from "./connections-store.js";
import { toAgentMcpServer, toPublicConnection } from "./connections-store.js";

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
      /**
       * Registry publications never carry the Official badge: a DNS-
       * verified vendor namespace only proves the publisher owns a domain,
       * and a dozen "Official" rows for one search means nothing. Kept as
       * `false` so the two result kinds share a shape.
       */
      official: boolean;
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
    /** From Anthropic's own curated marketplace (the one trusted repo). */
    official: boolean;
    /** Where to read about the plugin (its repository / subdirectory). */
    pageUrl?: string;
  }>;
}

const MARKETPLACE_CACHE_MS = 10 * 60_000;
const REGISTRY_CACHE_MS = 5 * 60_000;

export class ConnectorsService {
  private readonly registryEntries = new Map<string, McpRegistryEntry>();
  private readonly pluginEntries = new Map<string, MarketplacePluginEntry>();
  private readonly marketplaceCache = new Map<
    string,
    { entries: Promise<MarketplacePluginEntry[]>; at: number }
  >();
  private readonly registryQueryCache = new Map<
    string,
    { entries: McpRegistryEntry[]; at: number }
  >();

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
    const [registry, plugins] = await Promise.all([
      this.searchRegistry(query),
      this.searchPlugins(profileId, query),
    ]);
    return { registry, plugins };
  }

  /**
   * The registry half: a remote substring search (~1s round trip, and
   * >6000 servers, so no local mirror). Results are cached per query for
   * the session — backspacing through a query is instant the second time.
   */
  async searchRegistry(
    query: string,
  ): Promise<ConnectorSearchResult["registry"]> {
    const key = query.trim().toLowerCase();
    const cached = this.registryQueryCache.get(key);
    const registry =
      cached && Date.now() - cached.at < REGISTRY_CACHE_MS
        ? cached.entries
        : await searchMcpRegistry(query, { limit: 20 })
            .then((entries) => {
              this.registryQueryCache.set(key, { entries, at: Date.now() });
              return entries;
            })
            .catch(() => cached?.entries ?? []);
    for (const entry of registry) this.registryEntries.set(entry.name, entry);
    return registry.map((entry) => ({
      ...entry,
      official: false,
      suggested: entry.suggested
        ? {
            transport: entry.suggested.config.transport,
            inputs: entry.suggested.inputs,
          }
        : undefined,
    }));
  }

  /** The plugin half: a local filter over cached marketplaces (fast). */
  async searchPlugins(
    profileId: string,
    query: string,
  ): Promise<ConnectorSearchResult["plugins"]> {
    const installed = new Set(
      this.listInstalled(profileId).map((connector) => connector.name),
    );
    const plugins = await this.searchMarketplaces(profileId, query);
    for (const entry of plugins) {
      this.pluginEntries.set(`${entry.marketplace}#${entry.name}`, entry);
    }
    return plugins.map((entry) => ({
      name: entry.name,
      description: entry.description,
      version: entry.version,
      marketplace: entry.marketplace,
      installed: installed.has(entry.name),
      official: entry.marketplace === OFFICIAL_MARKETPLACE,
      pageUrl: pluginPageUrl(entry),
    }));
  }

  /** Marketplace lists, fetched once per TTL (they're GitHub files — a
   * fetch per keystroke was most of the search latency). */
  private marketplaceEntries(ref: string): Promise<MarketplacePluginEntry[]> {
    const cached = this.marketplaceCache.get(ref);
    if (cached && Date.now() - cached.at < MARKETPLACE_CACHE_MS) {
      return cached.entries;
    }
    const entries = fetchMarketplace(ref)
      .catch(() => [] as MarketplacePluginEntry[])
      .then((list) => {
        // Failures aren't cached for long — the next search retries.
        if (list.length === 0) this.marketplaceCache.delete(ref);
        return list;
      });
    this.marketplaceCache.set(ref, { entries, at: Date.now() });
    return entries;
  }

  private async searchMarketplaces(
    profileId: string,
    query: string,
  ): Promise<MarketplacePluginEntry[]> {
    const needle = query.trim().toLowerCase();
    const lists = await Promise.all(
      this.marketplaces(profileId).map((ref) => this.marketplaceEntries(ref)),
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
      mcpOAuth: {} as Record<string, McpOAuthClientHint>,
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
        ...(info.mcpOAuth[serverName]
          ? { oauthClient: info.mcpOAuth[serverName] }
          : {}),
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

  /**
   * Probe a stored connection (connect, list tools, close). A 401 from a
   * remote server is reported as `needsAuth` — the UI's cue to offer the
   * OAuth flow rather than print the raw error.
   */
  async probeConnection(
    profileId: string,
    connectionId: string,
  ): Promise<ConnectionProbeResult> {
    const store = this.deps.connectionsFor(profileId);
    const connection = store.get(connectionId);
    if (!connection) return { ok: false, error: "Connection not found" };
    // Tokens near expiry get refreshed first, so a probe never fails on a
    // token the refresher would have renewed a minute later.
    await this.refreshConnectionTokens(store, connection).catch(() => {});
    const config = toAgentMcpServer(store.get(connectionId) ?? connection);
    if (!config) return { ok: false, error: "Connection is incomplete" };
    const probe = await probeMcpServer(config);
    // A successful probe refreshes the cached roster the permission editor
    // lists and `auto` reads (annotations) for harnesses that can't see
    // them at call time.
    if (probe.ok && probe.tools) store.setTools(connectionId, probe.tools);
    if (
      !probe.ok &&
      config.transport !== "stdio" &&
      isAuthorizationError(probe.error)
    ) {
      return {
        ...probe,
        needsAuth: true,
        error: connection.oauth?.tokens
          ? "Authorization expired — authorize again"
          : "Needs authorization",
      };
    }
    return probe;
  }

  /**
   * Interactive OAuth for a remote connection: opens the consent page via
   * `openUrl`, catches the redirect on a loopback listener, stores tokens
   * on the connection. Resolves once tokens have been proven by a connect.
   */
  async authorizeConnection(
    profileId: string,
    connectionId: string,
    opts: {
      openUrl: (url: string) => void;
      onCallbackServed?: (origin: string) => void;
    },
  ): Promise<{ toolCount: number }> {
    const store = this.deps.connectionsFor(profileId);
    const connection = store.get(connectionId);
    if (!connection) throw new Error("Connection not found");
    if (connection.transport === "stdio" || !connection.url) {
      throw new Error("Only remote connections can be authorized");
    }
    const config: AgentMcpServerConfig = {
      transport: connection.transport,
      url: connection.url,
      ...(connection.headers ? { headers: connection.headers } : {}),
    };
    // Connections lifted from a plugin before it declared (or before we
    // read) an `oauth` block: consult the installed plugin directly.
    let client = connection.oauthClient;
    if (!client && connection.source.kind === "plugin") {
      const plugin = this.listInstalled(profileId).find(
        (entry) =>
          connection.source.kind === "plugin" &&
          entry.name === connection.source.plugin,
      );
      if (plugin) {
        client = await readInstalledPlugin(plugin.path)
          .then((info) => info.mcpOAuth[connection.name])
          .catch(() => undefined);
      }
    }
    const result = await authorizeMcpServer(config, {
      store: oauthStoreFor(store, connectionId),
      openUrl: opts.openUrl,
      onCallbackServed: opts.onCallbackServed,
      ...(client ? { client } : {}),
    });
    return { toolCount: result.toolCount };
  }

  /** Refresh one connection's tokens if they're near expiry. */
  private async refreshConnectionTokens(
    store: ConnectionsStore,
    connection: McpConnection,
  ): Promise<void> {
    if (!connection.oauth?.tokens || !connection.url) return;
    if (connection.transport === "stdio") return;
    await refreshMcpTokens(
      {
        transport: connection.transport,
        url: connection.url,
        ...(connection.headers ? { headers: connection.headers } : {}),
      },
      oauthStoreFor(store, connection.id),
    );
  }

  /**
   * Keep every OAuth-backed connection's bearer token fresh. Runs at boot
   * and on a timer; the harnesses that read the token as a plain header
   * (Claude Code, Codex) never refresh it themselves.
   */
  async refreshTokens(profileId: string): Promise<void> {
    const store = this.deps.connectionsFor(profileId);
    for (const connection of store.list()) {
      if (!connection.enabled || !connection.oauth?.tokens) continue;
      await this.refreshConnectionTokens(store, connection).catch(() => {});
    }
  }
}

export type ConnectionProbeResult = McpConnectionProbe & {
  /** The server wants a user to authorize (401); offer the OAuth flow. */
  needsAuth?: boolean;
};

/** The OAuth persistence seam: state lives on the connection record. */
function oauthStoreFor(
  store: ConnectionsStore,
  connectionId: string,
): McpOAuthStore {
  return {
    load: () => store.get(connectionId)?.oauth ?? {},
    save: (state) => store.setOAuth(connectionId, state),
  };
}

function sanitizeDirName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, "-");
}

/** The one marketplace whose plugins read "Official" and sort first. */
const OFFICIAL_MARKETPLACE = "anthropics/claude-plugins-official";

/** Human-readable home for a plugin: its repo (or subdirectory) on GitHub. */
function pluginPageUrl(entry: MarketplacePluginEntry): string | undefined {
  if (entry.source.kind === "url") return entry.source.url;
  const base = entry.source.url.replace(/\.git$/, "");
  if (!/^https?:\/\//.test(base)) return undefined;
  return entry.source.subdir && base.startsWith("https://github.com/")
    ? `${base}/tree/HEAD/${entry.source.subdir}`
    : base;
}
