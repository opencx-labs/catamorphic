import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { AgentMcpServerConfig } from "@catamorphic/sandbox";

const execFileAsync = promisify(execFile);

/**
 * Claude Code / Cowork plugin marketplaces. The format is open and publicly
 * documented: a marketplace is any git repo (or URL) carrying
 * `.claude-plugin/marketplace.json`; a plugin is a directory carrying
 * `.claude-plugin/plugin.json` plus optional skills/agents/hooks/commands
 * and MCP servers (`.mcp.json` or a `mcpServers` block). Anthropic's
 * official marketplaces (Apache-2.0) ship the same format Cowork uses.
 *
 * Cross-harness rule: a plugin's MCP servers are LIFTED into
 * harness-neutral {@link AgentMcpServerConfig}s so every harness gets them;
 * only the Claude Code harness additionally loads the plugin natively (with
 * MCP discovery disabled — the host owns those connections).
 */

/** Marketplaces every profile can search without any setup. */
export const DEFAULT_MARKETPLACES = [
  "anthropics/claude-plugins-official",
  "anthropics/knowledge-work-plugins",
];

export interface MarketplacePluginEntry {
  name: string;
  description: string;
  version?: string;
  /** Marketplace reference this entry came from (e.g. "owner/repo"). */
  marketplace: string;
  /** Where the plugin's files live, normalized for install. */
  source: PluginSource;
}

export type PluginSource =
  | { kind: "git"; url: string; subdir?: string }
  | { kind: "url"; url: string };

interface RawMarketplace {
  name?: string;
  plugins?: Array<{
    name?: string;
    description?: string;
    version?: string;
    source?: unknown;
  }>;
}

/** "owner/repo" GitHub shorthand, a full git URL, or a marketplace.json URL. */
export function marketplaceJsonUrls(ref: string): string[] {
  if (/^https?:\/\//.test(ref)) {
    if (ref.endsWith(".json")) return [ref];
    const github = ref.match(
      /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/,
    );
    if (github) {
      return [
        `https://raw.githubusercontent.com/${github[1]}/${github[2]}/HEAD/.claude-plugin/marketplace.json`,
      ];
    }
    return [`${ref.replace(/\/$/, "")}/.claude-plugin/marketplace.json`];
  }
  return [
    `https://raw.githubusercontent.com/${ref}/HEAD/.claude-plugin/marketplace.json`,
  ];
}

/** The clone URL for a marketplace reference. */
export function marketplaceGitUrl(ref: string): string {
  if (/^https?:\/\//.test(ref)) return ref;
  return `https://github.com/${ref}.git`;
}

export async function fetchMarketplace(
  ref: string,
  opts?: { fetchImpl?: typeof fetch },
): Promise<MarketplacePluginEntry[]> {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  let lastError: unknown;
  for (const url of marketplaceJsonUrls(ref)) {
    try {
      const response = await fetchImpl(url, {
        headers: { accept: "application/json" },
      });
      if (!response.ok) {
        lastError = new Error(`${url} answered ${response.status}`);
        continue;
      }
      return parseMarketplace(ref, (await response.json()) as RawMarketplace);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`Could not load marketplace ${ref}`);
}

export function parseMarketplace(
  ref: string,
  raw: RawMarketplace,
): MarketplacePluginEntry[] {
  const entries: MarketplacePluginEntry[] = [];
  for (const plugin of raw.plugins ?? []) {
    if (!plugin.name) continue;
    const source = normalizeSource(ref, plugin.source);
    if (!source) continue;
    entries.push({
      name: plugin.name,
      description: plugin.description ?? "",
      version: plugin.version,
      marketplace: ref,
      source,
    });
  }
  return entries;
}

/**
 * Marketplace `source` forms: a relative path inside the marketplace repo,
 * `{ source: "github", repo }`, `{ source: "url"|"git", url }`, or
 * `{ source: "git-subdir", url, path }`.
 */
function normalizeSource(
  marketplaceRef: string,
  source: unknown,
): PluginSource | undefined {
  if (typeof source === "string") {
    return {
      kind: "git",
      url: marketplaceGitUrl(marketplaceRef),
      subdir: source.replace(/^\.\//, ""),
    };
  }
  if (!source || typeof source !== "object") return undefined;
  const record = source as Record<string, unknown>;
  if (record.source === "github" && typeof record.repo === "string") {
    return { kind: "git", url: `https://github.com/${record.repo}.git` };
  }
  if (typeof record.url === "string") {
    if (record.source === "git-subdir" && typeof record.path === "string") {
      return { kind: "git", url: record.url, subdir: record.path };
    }
    return { kind: "git", url: record.url };
  }
  return undefined;
}

/**
 * Shallow-clone a plugin into `targetDir` (replacing any previous install).
 * For subdir sources the marketplace repo is cloned to a temp sibling and
 * only the plugin directory is kept.
 */
export async function installPluginFromSource(
  source: PluginSource,
  targetDir: string,
): Promise<void> {
  await fs.rm(targetDir, { recursive: true, force: true });
  await fs.mkdir(path.dirname(targetDir), { recursive: true });
  if (source.kind === "url") {
    throw new Error("Direct-URL plugin sources are not supported yet.");
  }
  if (!source.subdir) {
    await execFileAsync(
      "git",
      ["clone", "--depth", "1", source.url, targetDir],
      { timeout: 120_000 },
    );
    await fs.rm(path.join(targetDir, ".git"), { recursive: true, force: true });
    return;
  }
  const staging = `${targetDir}.staging`;
  await fs.rm(staging, { recursive: true, force: true });
  try {
    await execFileAsync("git", ["clone", "--depth", "1", source.url, staging], {
      timeout: 120_000,
    });
    const pluginDir = path.join(staging, source.subdir);
    const stat = await fs.stat(pluginDir).catch(() => null);
    if (!stat?.isDirectory()) {
      throw new Error(
        `Plugin directory "${source.subdir}" not found in ${source.url}`,
      );
    }
    await fs.cp(pluginDir, targetDir, { recursive: true });
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

export interface InstalledPluginInfo {
  name: string;
  description: string;
  version?: string;
  /** MCP servers the plugin declares, lifted to harness-neutral configs. */
  mcpServers: Record<string, AgentMcpServerConfig>;
}

/** Read an installed plugin's manifest and lift its MCP servers. */
export async function readInstalledPlugin(
  pluginDir: string,
): Promise<InstalledPluginInfo> {
  const manifestPath = path.join(pluginDir, ".claude-plugin", "plugin.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf-8")) as {
    name?: string;
    description?: string;
    version?: string;
    mcpServers?: Record<string, unknown>;
  };
  const mcpJson = await fs
    .readFile(path.join(pluginDir, ".mcp.json"), "utf-8")
    .then((raw) => JSON.parse(raw) as Record<string, unknown>)
    .catch(() => undefined);
  const declared = {
    ...((mcpJson?.mcpServers as Record<string, unknown> | undefined) ??
      mcpJson ??
      {}),
    ...(manifest.mcpServers ?? {}),
  };
  const mcpServers: Record<string, AgentMcpServerConfig> = {};
  for (const [name, raw] of Object.entries(declared)) {
    const lifted = liftMcpServer(raw, pluginDir);
    if (lifted) mcpServers[name] = lifted;
  }
  return {
    name: manifest.name ?? path.basename(pluginDir),
    description: manifest.description ?? "",
    version: manifest.version,
    mcpServers,
  };
}

/** Claude Code `.mcp.json` entry → harness-neutral config. */
export function liftMcpServer(
  raw: unknown,
  pluginRoot?: string,
): AgentMcpServerConfig | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  const substitute = (value: string): string =>
    pluginRoot
      ? // biome-ignore lint/suspicious/noTemplateCurlyInString: the plugin spec's literal placeholder syntax
        value.replaceAll("${CLAUDE_PLUGIN_ROOT}", pluginRoot)
      : value;
  if (typeof record.url === "string") {
    const type = record.type === "sse" ? "sse" : "http";
    return {
      transport: type,
      url: record.url,
      ...(record.headers && typeof record.headers === "object"
        ? { headers: record.headers as Record<string, string> }
        : {}),
    };
  }
  if (typeof record.command === "string") {
    return {
      transport: "stdio",
      command: substitute(record.command),
      ...(Array.isArray(record.args)
        ? { args: record.args.map((arg) => substitute(String(arg))) }
        : {}),
      ...(record.env && typeof record.env === "object"
        ? {
            env: Object.fromEntries(
              Object.entries(record.env as Record<string, string>).map(
                ([key, value]) => [key, substitute(String(value))],
              ),
            ),
          }
        : {}),
    };
  }
  return undefined;
}
