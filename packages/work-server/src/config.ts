import {
  executionSettingsFromEnv,
  type WorkExecutionSettings,
} from "./execution-config.js";
import {
  type GatewayConfig,
  gatewayConfigFromFile,
} from "./gateway/gateway-config.js";

export type WorkAgentEffort = "low" | "medium" | "high";

/** The model behind the built-in project assistant. */
export interface WorkAgentSettings {
  provider?:
    | { kind: "anthropic"; apiKey: string }
    | { kind: "openrouter"; apiKey: string }
    | { kind: "openai"; apiKey: string };
  /** Model id; Anthropic defaults to claude-opus-5. */
  model?: string;
  effort: WorkAgentEffort;
  /** Deterministic echo agent for tests and dry runs. */
  fake: boolean;
}

/**
 * Everything a Work server needs to boot (ADR 0160). The image derives it from
 * `WORK_*` variables with {@link workServerConfigFromEnv}; a custom server may
 * construct it in code.
 */
export interface WorkServerConfig {
  /** Owner-only directory for local state (PGlite, origins, credentials). */
  dataDir: string;
  /**
   * Origins without a trailing slash. The first names the server in OAuth
   * metadata, invitation links, and webhook URLs.
   */
  publicBases: string[];
  /** Deployment secret; required with `databaseUrl`. Generated when absent. */
  secret?: string;
  /**
   * Credential vault keys (32 bytes each), current first, then keys still
   * needed to open older records. Required with `databaseUrl` unless the
   * `vaultKeys` hook supplies them; kept separate from `secret` (ADR 0162).
   */
  vaultKeys?: Uint8Array[];
  /** Network Postgres. Absent means PGlite under `dataDir`. */
  databaseUrl?: string;
  /** Sign-in configuration file (default `<dataDir>/auth-config.json`). */
  authConfigPath?: string;
  /** Label of this machine in inventory and Environment pickers. */
  machineName: string;
  execution: WorkExecutionSettings;
  agent: WorkAgentSettings;
  /** Service account for GitHub-backed projects and proposals. */
  github?: { clientId: string; token: string };
  /**
   * Connections the gateway brokers (MCP endpoints, HTTP APIs, databases) and
   * the guards that review their actions (ADRs 0162, 0163).
   */
  gateway?: GatewayConfig;
  webPushSubject?: string;
  /** Loopback operator credential. Generated under `dataDir` when absent. */
  operatorSecret?: string;
  /** Built PWA served at the root. */
  pwaDist?: string;
}

export function workServerConfigFromEnv(
  env: Record<string, string | undefined>,
): WorkServerConfig {
  const port = Number(env.PORT ?? 4700);
  const publicUrl = env.WORK_PUBLIC_URL?.replace(/\/+$/, "");
  if (publicUrl && !isSecurePublicUrl(publicUrl)) {
    throw new Error(
      "WORK_PUBLIC_URL must use HTTPS except for a loopback address",
    );
  }
  const loopbackBase = `http://127.0.0.1:${port}`;
  const github = env.WORK_GITHUB_TOKEN || env.WORK_GITHUB_CLIENT_ID;
  if (github && (!env.WORK_GITHUB_TOKEN || !env.WORK_GITHUB_CLIENT_ID)) {
    throw new Error(
      "Configure both WORK_GITHUB_TOKEN and WORK_GITHUB_CLIENT_ID for the server's GitHub connection",
    );
  }
  return {
    dataDir: env.WORK_DATA_DIR ?? "/data",
    // OAuth discovery and invitation links publish only a secure public
    // origin or exact loopback. LAN HTTP never carries bearer credentials.
    publicBases: [...(publicUrl ? [publicUrl] : []), loopbackBase].filter(
      (base, index, all) => all.indexOf(base) === index,
    ),
    ...(env.WORK_SECRET ? { secret: env.WORK_SECRET } : {}),
    ...(env.WORK_VAULT_KEY
      ? {
          vaultKeys: [
            env.WORK_VAULT_KEY,
            ...(env.WORK_VAULT_PREVIOUS_KEYS ?? "")
              .split(",")
              .map((key) => key.trim())
              .filter(Boolean),
          ].map(decodeVaultKey),
        }
      : {}),
    ...(env.DATABASE_URL ? { databaseUrl: env.DATABASE_URL } : {}),
    ...(env.WORK_AUTH_CONFIG ? { authConfigPath: env.WORK_AUTH_CONFIG } : {}),
    machineName: env.WORK_MACHINE_NAME ?? "Work server",
    execution: executionSettingsFromEnv(env),
    agent: agentSettingsFromEnv(env),
    ...(env.WORK_GITHUB_TOKEN && env.WORK_GITHUB_CLIENT_ID
      ? {
          github: {
            clientId: env.WORK_GITHUB_CLIENT_ID,
            token: env.WORK_GITHUB_TOKEN,
          },
        }
      : {}),
    ...(env.WORK_GATEWAY_CONFIG
      ? {
          gateway: gatewayConfigFromFile({
            path: env.WORK_GATEWAY_CONFIG,
            env,
          }),
        }
      : {}),
    ...(env.WORK_WEB_PUSH_SUBJECT
      ? { webPushSubject: env.WORK_WEB_PUSH_SUBJECT }
      : {}),
    ...(env.WORK_OPERATOR_SECRET
      ? { operatorSecret: env.WORK_OPERATOR_SECRET }
      : {}),
    ...(env.WORK_PWA_DIST ? { pwaDist: env.WORK_PWA_DIST } : {}),
  };
}

function agentSettingsFromEnv(
  env: Record<string, string | undefined>,
): WorkAgentSettings {
  const provider = env.ANTHROPIC_API_KEY
    ? { kind: "anthropic" as const, apiKey: env.ANTHROPIC_API_KEY }
    : env.OPENROUTER_API_KEY
      ? { kind: "openrouter" as const, apiKey: env.OPENROUTER_API_KEY }
      : env.OPENAI_API_KEY
        ? { kind: "openai" as const, apiKey: env.OPENAI_API_KEY }
        : undefined;
  const effort = env.WORK_EFFORT;
  return {
    ...(provider ? { provider } : {}),
    ...(env.WORK_MODEL ? { model: env.WORK_MODEL } : {}),
    effort: effort === "low" || effort === "high" ? effort : "medium",
    fake: env.WORK_FAKE_AGENT === "1",
  };
}

/** A vault key is 32 random bytes, written as base64 or 64 hex digits. */
export function decodeVaultKey(encoded: string): Uint8Array {
  const bytes = /^[0-9a-f]{64}$/i.test(encoded)
    ? Buffer.from(encoded, "hex")
    : Buffer.from(encoded, "base64");
  if (bytes.byteLength !== 32) {
    throw new Error(
      "WORK_VAULT_KEY must be 32 random bytes as base64 or hex (for example: openssl rand -base64 32)",
    );
  }
  return new Uint8Array(bytes);
}

export function isSecurePublicUrl(raw: string): boolean {
  const url = new URL(raw);
  return (
    url.protocol === "https:" ||
    (url.protocol === "http:" &&
      (url.hostname === "localhost" ||
        url.hostname === "[::1]" ||
        /^127(?:\.\d{1,3}){3}$/.test(url.hostname)))
  );
}
