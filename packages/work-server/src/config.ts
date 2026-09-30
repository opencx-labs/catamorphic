import path from "node:path";
import {
  type WorkAuthConfig,
  workAuthConfigFromFile,
} from "./auth/auth-config.js";
import {
  executionSettingsFromEnv,
  type WorkExecutionSettings,
} from "./execution-config.js";
import {
  type GatewayConfig,
  gatewayConfigFromFile,
} from "./gateway/gateway-config.js";
import { NodeLabelsSchema } from "./workers/placement.js";

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
 * Everything a Work server needs to boot (ADR 0160): typed, serializable data,
 * validated at boot by the same schemas as the image's files (ADR 0183). The
 * image derives it from `WORK_*` variables and files with
 * {@link workServerConfigFromEnv}, the only code that knows either; a custom
 * server may construct it in code. Code, such as connection guards, goes in
 * `hooks`.
 */
export interface WorkServerConfig {
  /**
   * Owner-only directory for local state (PGlite, origins, credentials).
   * With `databaseUrl` it holds only working copies and sandboxes (ADR
   * 0190).
   */
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
  /**
   * Sign-in providers and session policy. Absent means local sign-in only,
   * with default policies. The image reads it from `WORK_AUTH_CONFIG`
   * (default `<WORK_DATA_DIR>/auth-config.json`).
   */
  auth?: WorkAuthConfig;
  /** Label of this machine in inventory and Environment pickers. */
  machineName: string;
  /**
   * Labels Environments select this control-plane machine by (ADR 0167),
   * from `WORK_MACHINE_LABELS=pool=agents,class=large`.
   */
  machineLabels: Record<string, string>;
  execution: WorkExecutionSettings;
  agent: WorkAgentSettings;
  /**
   * Connections the gateway brokers (MCP endpoints, HTTP APIs, databases,
   * Git hosts, model APIs) with their secrets resolved (ADRs 0162, 0163).
   * The image reads it from `WORK_GATEWAY_CONFIG`.
   */
  gateway?: GatewayConfig;
  /**
   * How long one of `hooks.connectionGuards` may take before its action
   * goes to a person (default 30 seconds, ADR 0183).
   */
  connectionGuardTimeoutMs?: number;
  webPushSubject?: string;
  /**
   * Loopback operator credential, the same on every replica. Required with
   * `databaseUrl`; a single PGlite server generates one under `dataDir`.
   */
  operatorSecret?: string;
  /** Built PWA served at the root. */
  pwaDist?: string;
  /**
   * Largest webhook body any endpoint may accept, from
   * `WORK_WEBHOOK_MAX_BYTES` (default 1 MiB, at most 64 MiB).
   */
  webhookMaxBodyBytes?: number;
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
  const dataDir = env.WORK_DATA_DIR ?? "/data";
  return {
    dataDir,
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
    auth: workAuthConfigFromFile(
      env.WORK_AUTH_CONFIG ?? path.join(dataDir, "auth-config.json"),
    ),
    machineName: env.WORK_MACHINE_NAME ?? "Work server",
    machineLabels: parseMachineLabels(env.WORK_MACHINE_LABELS),
    execution: executionSettingsFromEnv(env),
    agent: agentSettingsFromEnv(env),
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
    ...(env.WORK_WEBHOOK_MAX_BYTES
      ? { webhookMaxBodyBytes: webhookMaxBytes(env.WORK_WEBHOOK_MAX_BYTES) }
      : {}),
  };
}

function webhookMaxBytes(value: string): number {
  const bytes = Number(value);
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > 64 * 1024 * 1024)
    throw new Error(
      "WORK_WEBHOOK_MAX_BYTES must be a whole number of bytes up to 67108864 (64 MiB)",
    );
  return bytes;
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

function parseMachineLabels(value: string | undefined): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const pair of (value ?? "").split(",")) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const [key, ...rest] = trimmed.split("=");
    const label = rest.join("=").trim();
    if (!key || !label) {
      throw new Error(
        `WORK_MACHINE_LABELS entries look like name=value, got '${trimmed}'`,
      );
    }
    labels[key.trim()] = label;
  }
  return NodeLabelsSchema.parse(labels);
}
