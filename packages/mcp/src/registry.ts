import type { AgentMcpServerConfig } from "@catamorphic/sandbox";
import { pickIcon } from "./client.js";

/**
 * Client for the official MCP Registry (registry.modelcontextprotocol.io,
 * REST API v0.1 — frozen, unauthenticated reads). Entries are `server.json`
 * documents; {@link suggestConnection} turns one into a ready-to-save
 * connection config plus the list of secrets the user must fill in.
 * Preference order: streamable-http remote > sse remote > npm/pypi/oci
 * package run locally over stdio.
 */

export const MCP_REGISTRY_URL = "https://registry.modelcontextprotocol.io";

interface RegistryKeyValue {
  name: string;
  description?: string;
  value?: string;
  default?: string;
  isRequired?: boolean;
  isSecret?: boolean;
}

interface RegistryArgument extends RegistryKeyValue {
  type?: "positional" | "named";
}

interface RegistryRemote {
  type: string;
  url: string;
  headers?: RegistryKeyValue[];
}

interface RegistryPackage {
  registryType: string;
  identifier: string;
  version?: string;
  runtimeHint?: string;
  runtimeArguments?: RegistryArgument[];
  packageArguments?: RegistryArgument[];
  environmentVariables?: RegistryKeyValue[];
  transport?: { type: string };
}

export interface RegistryServerJson {
  name: string;
  /** Human-readable name (2025-09-29 schema), e.g. "Apex AI Academy". */
  title?: string;
  description?: string;
  /** The server's home on the web, distinct from its repository. */
  websiteUrl?: string;
  version?: string;
  repository?: { url?: string };
  remotes?: RegistryRemote[];
  packages?: RegistryPackage[];
  /** Icons metadata (2025-11-25); server.json carries a top-level array. */
  icons?: unknown;
}

/** A value the user must supply before the connection can work. */
export interface ConnectionInput {
  /** Header name or env var name, depending on `kind`. */
  name: string;
  kind: "header" | "env";
  description?: string;
  required: boolean;
  secret: boolean;
}

export interface SuggestedConnection {
  config: AgentMcpServerConfig;
  /** Placeholders in `config` the user still needs to fill. */
  inputs: ConnectionInput[];
}

export interface McpRegistryEntry {
  /** Reverse-DNS registry name, e.g. "io.github.owner/server". */
  name: string;
  /** The entry's title, else the part of its name after the namespace. */
  displayName: string;
  description: string;
  version?: string;
  repositoryUrl?: string;
  /** The server's https home page, when it names one. */
  websiteUrl?: string;
  status?: string;
  /** Best displayable icon (https/data only), when the entry carries one. */
  iconUrl?: string;
  suggested?: SuggestedConnection;
}

interface RegistryListResponse {
  servers?: Array<{
    server?: RegistryServerJson;
    _meta?: Record<string, { status?: string; isLatest?: boolean }>;
  }>;
}

export async function searchMcpRegistry(
  query: string,
  opts?: { limit?: number; fetchImpl?: typeof fetch; baseUrl?: string },
): Promise<McpRegistryEntry[]> {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const base = opts?.baseUrl ?? MCP_REGISTRY_URL;
  const url = new URL("/v0.1/servers", base);
  if (query.trim()) url.searchParams.set("search", query.trim());
  url.searchParams.set("limit", String(opts?.limit ?? 20));
  url.searchParams.set("version", "latest");
  const response = await fetchImpl(url, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`MCP registry answered ${response.status}`);
  }
  const data = (await response.json()) as RegistryListResponse;
  const entries: McpRegistryEntry[] = [];
  for (const row of data.servers ?? []) {
    if (!row.server?.name) continue;
    const official = row._meta?.["io.modelcontextprotocol.registry/official"];
    // Deleted/deprecated entries stay searchable in the registry but must
    // not be offered for install.
    if (official?.status && official.status !== "active") continue;
    entries.push(toEntry(row.server, official?.status));
  }
  return entries;
}

/** An https address, or nothing: entries are third-party data. */
function httpsUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    return new URL(value).protocol === "https:" ? value : undefined;
  } catch {
    return undefined;
  }
}

export function toEntry(
  server: RegistryServerJson,
  status?: string,
): McpRegistryEntry {
  const iconUrl = pickIcon(server.icons);
  const title =
    typeof server.title === "string" ? server.title.trim() : undefined;
  const websiteUrl = httpsUrl(server.websiteUrl);
  return {
    name: server.name,
    displayName: title || (server.name.split("/").pop() ?? server.name),
    description: server.description ?? "",
    version: server.version,
    repositoryUrl: server.repository?.url,
    ...(websiteUrl ? { websiteUrl } : {}),
    status,
    ...(iconUrl ? { iconUrl } : {}),
    suggested: suggestConnection(server),
  };
}

/**
 * Pick the best way to run a registry server and prefill its config.
 * Returns undefined when the entry carries nothing installable.
 */
export function suggestConnection(
  server: RegistryServerJson,
): SuggestedConnection | undefined {
  const remote =
    server.remotes?.find((entry) => entry.type === "streamable-http") ??
    server.remotes?.find((entry) => entry.type === "sse");
  if (remote) {
    const headers: Record<string, string> = {};
    const inputs: ConnectionInput[] = [];
    for (const header of remote.headers ?? []) {
      if (header.value ?? header.default) {
        headers[header.name] = header.value ?? header.default ?? "";
      }
      if (!header.value) {
        inputs.push({
          name: header.name,
          kind: "header",
          description: header.description,
          required: header.isRequired ?? false,
          secret: header.isSecret ?? false,
        });
      }
    }
    return {
      config: {
        transport: remote.type === "sse" ? "sse" : "http",
        url: remote.url,
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
      },
      inputs,
    };
  }

  const pkg =
    server.packages?.find((entry) => entry.registryType === "npm") ??
    server.packages?.find((entry) => entry.registryType === "pypi") ??
    server.packages?.find((entry) => entry.registryType === "oci");
  if (!pkg) return undefined;
  const spec = packageCommand(pkg);
  if (!spec) return undefined;

  const env: Record<string, string> = {};
  const inputs: ConnectionInput[] = [];
  for (const variable of pkg.environmentVariables ?? []) {
    env[variable.name] = variable.value ?? variable.default ?? "";
    if (!variable.value) {
      inputs.push({
        name: variable.name,
        kind: "env",
        description: variable.description,
        required: variable.isRequired ?? false,
        secret: variable.isSecret ?? false,
      });
    }
  }
  return {
    config: {
      transport: "stdio",
      command: spec.command,
      args: spec.args,
      ...(Object.keys(env).length > 0 ? { env } : {}),
    },
    inputs,
  };
}

function packageCommand(
  pkg: RegistryPackage,
): { command: string; args: string[] } | undefined {
  const argValues = (args?: RegistryArgument[]): string[] =>
    (args ?? []).flatMap((arg) => {
      const value = arg.value ?? arg.default;
      if (arg.type === "named") {
        return value !== undefined ? [arg.name, value] : [arg.name];
      }
      return value !== undefined ? [value] : [];
    });
  const runtime = argValues(pkg.runtimeArguments);
  const packageArgs = argValues(pkg.packageArguments);
  const pinned = pkg.version
    ? `${pkg.identifier}@${pkg.version}`
    : pkg.identifier;
  switch (pkg.registryType) {
    case "npm":
      return {
        command: "npx",
        args: ["-y", ...runtime, pinned, ...packageArgs],
      };
    case "pypi":
      return { command: "uvx", args: [...runtime, pinned, ...packageArgs] };
    case "oci":
      return {
        command: "docker",
        args: ["run", "-i", "--rm", ...runtime, pkg.identifier, ...packageArgs],
      };
    default:
      return undefined;
  }
}
