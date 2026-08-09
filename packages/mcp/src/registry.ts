import type { AgentMcpServerConfig } from "@catamorphic/sandbox";

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
  description?: string;
  version?: string;
  repository?: { url?: string };
  remotes?: RegistryRemote[];
  packages?: RegistryPackage[];
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
  /** Short display name (the part after the namespace). */
  displayName: string;
  description: string;
  version?: string;
  repositoryUrl?: string;
  status?: string;
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

export function toEntry(
  server: RegistryServerJson,
  status?: string,
): McpRegistryEntry {
  return {
    name: server.name,
    displayName: server.name.split("/").pop() ?? server.name,
    description: server.description ?? "",
    version: server.version,
    repositoryUrl: server.repository?.url,
    status,
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
