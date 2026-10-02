import { homedir } from "node:os";
import path from "node:path";
import type { JsonObject, JsonValue } from "@catamorphic/agent-protocol";
import type {
  AttemptStart,
  McpServerSpec,
  PolicyLayer,
} from "@catamorphic/agent-protocol/runner";
import { resolveToolPermissionAcross } from "@catamorphic/sandbox";
import { codexConfigArgs, isObject } from "./app-server.js";
import type { CodexSpawn } from "./transport.js";

export type CodexSandboxMode =
  | "read-only"
  | "workspace-write"
  | "danger-full-access";
export type CodexApprovalPolicy =
  | "untrusted"
  | "on-failure"
  | "on-request"
  | "never";

/**
 * The adapter-specific settings a host configures per agent, read from
 * {@link AttemptStart.options}. Everything here is data.
 */
export interface CodexOptions {
  /** The `codex` executable (default `codex` on PATH). */
  command: string;
  /** Use the host's subsessions instead of Codex's private agents. */
  disableNativeSubagents: boolean;
  /** Use the host's session todos instead of Codex's private goals. */
  disableNativeGoals: boolean;
  /** Network access inside the `workspace-write` sandbox (default true). */
  networkAccess: boolean;
  /** Extra Codex config overrides (`-c key=value`), merged last. */
  config: JsonObject;
}

export function readOptions(options: JsonObject): CodexOptions {
  return {
    command:
      typeof options.command === "string" && options.command
        ? options.command
        : "codex",
    disableNativeSubagents: options.disableNativeSubagents === true,
    disableNativeGoals: options.disableNativeGoals === true,
    networkAccess: options.networkAccess !== false,
    config: isObject(options.config) ? options.config : {},
  };
}

/** How often Codex re-reads its key: grants are renewed every 20 minutes. */
const KEY_REFRESH_MS = 5 * 60_000;

/**
 * Codex's model provider for the gateway (ADR 0180): its Responses API,
 * authenticated by a command that prints the session's current grant.
 */
export function gatewayProviderConfig(gateway: {
  baseUrl: string;
}): JsonObject {
  return {
    model_provider: "work",
    model_providers: {
      work: {
        name: "Work gateway",
        base_url: gateway.baseUrl,
        wire_api: "responses",
        auth: {
          command: "sh",
          args: ["-c", 'cat "$WORK_MODEL_KEY_FILE"'],
          refresh_interval_ms: KEY_REFRESH_MS,
        },
      },
    },
  };
}

/** A Codex MCP server key: TOML bare keys only. */
export function codexServerKey(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, "_");
}

/**
 * Known tools a policy denies outright, so Codex never offers them. Every
 * other tool on a server with a policy asks before it runs, and the
 * runner decides that ask by the same policy (`AttemptHost.authorize`).
 */
export function codexToolFilter(
  layers: PolicyLayer[] | undefined,
  annotations:
    | Record<string, { readOnlyHint?: boolean; destructiveHint?: boolean }>
    | undefined,
): { disabled_tools?: string[] } {
  if (!layers || layers.length === 0) return {};
  const known = new Set<string>([
    ...layers.flatMap((layer) => Object.keys(layer.tools ?? {})),
    ...Object.keys(annotations ?? {}),
  ]);
  const denied = [...known]
    .sort()
    .filter(
      (tool) =>
        resolveToolPermissionAcross(layers, tool, annotations?.[tool]) ===
        "deny",
    );
  return denied.length > 0 ? { disabled_tools: denied } : {};
}

/** Host-neutral MCP servers as Codex `mcp_servers` config. */
export function mcpServersConfig(input: {
  servers: Record<string, McpServerSpec>;
  policies: Record<string, PolicyLayer[]>;
  annotations: AttemptStart["toolAnnotations"];
}): JsonObject | undefined {
  const entries = Object.entries(input.servers);
  if (entries.length === 0) return undefined;
  const servers: JsonObject = {};
  for (const [name, spec] of entries) {
    const layers = input.policies[name];
    const filter = codexToolFilter(layers, input.annotations[name]);
    const approvalMode =
      layers && layers.length > 0
        ? "prompt"
        : spec.transport === "stdio"
          ? undefined
          : spec.defaultToolsApprovalMode;
    servers[codexServerKey(name)] = {
      ...(spec.transport === "stdio"
        ? {
            command: spec.command,
            ...(spec.args ? { args: spec.args } : {}),
            ...(spec.env ? { env: spec.env } : {}),
          }
        : {
            url: spec.url,
            ...(spec.headers ? { http_headers: spec.headers } : {}),
          }),
      ...(filter.disabled_tools
        ? { disabled_tools: filter.disabled_tools }
        : {}),
      ...(approvalMode ? { default_tools_approval_mode: approvalMode } : {}),
    };
  }
  return servers;
}

/** Everything the adapter derives from an attempt before it spawns Codex. */
export interface CodexLaunch {
  spawn: CodexSpawn;
  /** `CODEX_HOME` of this attempt: where rollouts live. */
  home: string;
  sandbox: CodexSandboxMode;
  approvalPolicy: CodexApprovalPolicy;
  /** Per-thread config sent with thread/start, resume and fork. */
  threadConfig: JsonObject;
  /** Codex MCP server key → the attempt's server key (for policy lookups). */
  serverKeys: Map<string, string>;
  options: CodexOptions;
}

/**
 * The process, home and thread settings for an attempt, or why it cannot
 * run. The model is reached as `modelAccess` says: through the gateway
 * (ADR 0180), with the owner's own sign-in in its own home (ADR 0198), or
 * however the host's own Codex configuration says.
 */
export function codexLaunch(attempt: AttemptStart): CodexLaunch | string {
  const options = readOptions(attempt.options);
  const env: Record<string, string> = { ...attempt.env };
  const access = attempt.modelAccess;
  let config: JsonObject = {};
  if (access.kind === "gateway") {
    if (access.api !== "openai")
      return `Codex speaks the OpenAI API; this chat's model connection is an ${access.api} API.`;
    config = gatewayProviderConfig({ baseUrl: access.baseUrl });
    env.WORK_MODEL_KEY_FILE = access.keyFile;
  }
  if (access.kind === "sign_in") env.CODEX_HOME = access.home;
  else if (access.kind === "gateway")
    env.CODEX_HOME ??= path.join(attempt.stateDirectory, "codex-home");
  // A host's own key, when it sets one, is Codex's provider credential.
  if (access.kind === "host" && env.CODEX_API_KEY) {
    const provider =
      typeof options.config.model_provider === "string"
        ? options.config.model_provider
        : "openai";
    config[`model_providers.${provider}.env_key`] = "CODEX_API_KEY";
    config[`model_providers.${provider}.requires_openai_auth`] = false;
  }
  const serverKeys = new Map<string, string>();
  for (const name of Object.keys(attempt.mcpServers))
    serverKeys.set(codexServerKey(name), name);
  const mcp = mcpServersConfig({
    servers: attempt.mcpServers,
    policies: attempt.toolPolicies,
    annotations: attempt.toolAnnotations,
  });
  if (mcp) config.mcp_servers = mcp;
  config.features = {
    // Structured questions outside plan mode (item/tool/requestUserInput);
    // the pinned CLI marks this under development, so transcripts pin it.
    default_mode_request_user_input: true,
    ...(options.disableNativeSubagents ? { multi_agent: false } : {}),
    ...(options.disableNativeGoals ? { goals: false } : {}),
  };
  config.suppress_unstable_features_warning = true;
  config = { ...config, ...options.config };
  const home =
    env.CODEX_HOME ?? process.env.CODEX_HOME ?? path.join(homedir(), ".codex");
  const permissions = attempt.permissions;
  const sandbox =
    sandboxMode(permissions.sandbox) ??
    // Outside the host the Work sandbox is the boundary (ADR 0176).
    (access.kind === "host" ? "workspace-write" : "danger-full-access");
  return {
    spawn: {
      command: options.command,
      args: ["app-server", ...codexConfigArgs(config)],
      env,
      cwd: attempt.workingDirectory,
    },
    home,
    sandbox,
    approvalPolicy: approvalPolicy(permissions.approvals) ?? "on-request",
    threadConfig: {
      "sandbox_workspace_write.network_access": options.networkAccess,
      // Summaries carry the headings the host shows as live status.
      model_reasoning_summary: "auto",
    },
    serverKeys,
    options,
  };
}

function sandboxMode(
  value: JsonValue | undefined,
): CodexSandboxMode | undefined {
  return value === "read-only" ||
    value === "workspace-write" ||
    value === "danger-full-access"
    ? value
    : undefined;
}

function approvalPolicy(
  value: JsonValue | undefined,
): CodexApprovalPolicy | undefined {
  return value === "untrusted" ||
    value === "on-failure" ||
    value === "on-request" ||
    value === "never"
    ? value
    : undefined;
}
