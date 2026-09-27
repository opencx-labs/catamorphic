import fs from "node:fs";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type {
  ConnectionActionGuard,
  ConnectionProvider,
} from "@catamorphic/core";
import { defineMcpConnectionProvider } from "@catamorphic/mcp";
import {
  defineHttpApiConnectionProvider,
  definePostgresConnectionProvider,
} from "@catamorphic/server-sdk";
import type { LanguageModel } from "ai";
import { z } from "zod";
import { defineApprovalGuard, defineModelGuard } from "./guards.js";

const Kind = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/);

const EnvName = z.string().regex(/^[A-Z][A-Z0-9_]*$/);

/**
 * A remote MCP server. `oauth.client` names a client registered with the
 * server's authorization server in advance, for servers without dynamic
 * client registration; its redirect URI is this server's
 * `<public origin>/api/connection-authorizations/callback` (ADR 0172).
 */
const McpEntry = z.strictObject({
  type: z.literal("mcp").default("mcp"),
  kind: Kind,
  displayName: z.string().min(1),
  url: z.url(),
  transport: z.enum(["http", "sse"]).default("http"),
  oauth: z
    .strictObject({
      client: z.strictObject({
        id: z.string().min(1),
        /** Environment variable holding a confidential client's secret. */
        secretEnv: EnvName.optional(),
        scopes: z.array(z.string().min(1)).optional(),
      }),
    })
    .optional(),
});

/** The host's ceilings on what a gateway file may configure. */
export const HTTP_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
export const HTTP_MAX_TIMEOUT_MS = 120_000;

/**
 * One named operation of an HTTP API (ADR 0179): a fixed method and path,
 * granted by name (`chat.postMessage`) instead of by HTTP method.
 */
const HttpAction = z.strictObject({
  name: z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{0,63}$/),
  method: z.enum(["get", "post", "put", "patch", "delete"]),
  path: z
    .string()
    .startsWith("/")
    .regex(/^[^?#%\\]*$/, "A plain path without query or escapes")
    .refine((path) => !path.includes(".."), "No '..' segments"),
  description: z.string().min(1).optional(),
});

/** An API reached through the gateway with a stored key (ADR 0162). */
const HttpEntry = z
  .strictObject({
    type: z.literal("http"),
    kind: Kind,
    displayName: z.string().min(1),
    baseUrl: z.url(),
    auth: z
      .strictObject({
        header: z.string().min(1),
        scheme: z.string().optional(),
      })
      .optional(),
    paths: z.array(z.string().startsWith("/")).optional(),
    /** Named operations; when present, the connection's only actions. */
    actions: z.array(HttpAction).min(1).optional(),
    /** Largest part of a body one call returns; larger GETs read in ranges. */
    maxResponseBytes: z
      .number()
      .int()
      .positive()
      .max(HTTP_MAX_RESPONSE_BYTES)
      .optional(),
    timeoutMs: z.number().int().positive().max(HTTP_MAX_TIMEOUT_MS).optional(),
  })
  .superRefine((entry, context) => {
    if (entry.actions && entry.paths)
      context.addIssue({
        code: "custom",
        path: ["actions"],
        message: "Declare either actions or paths, not both",
      });
    const names = entry.actions?.map((action) => action.name) ?? [];
    for (const [index, name] of names.entries())
      if (names.indexOf(name) !== index)
        context.addIssue({
          code: "custom",
          path: ["actions", index, "name"],
          message: `Duplicate action '${name}'`,
        });
  });

/** A database reached with a stored read-only credential (ADR 0163). */
const PostgresEntry = z.strictObject({
  type: z.literal("postgres"),
  kind: Kind,
  displayName: z.string().min(1),
  maxRows: z.number().int().positive().max(10_000).optional(),
  maxResultBytes: z.number().int().positive().optional(),
  maxCost: z.number().positive().optional(),
  maxPlanRows: z.number().positive().optional(),
  statementTimeoutMs: z.number().int().positive().max(120_000).optional(),
  lockTimeoutMs: z.number().int().positive().max(30_000).optional(),
  /** Sessions kept per service connection credential (ADR 0172). */
  poolSize: z.number().int().positive().max(16).optional(),
  poolIdleTimeoutMs: z.number().int().positive().max(600_000).optional(),
});

const Scope = {
  name: z.string().min(1),
  /** Connection kinds the guard reviews; absent reviews every connection. */
  kinds: z.array(Kind).optional(),
  /** Actions the guard reviews; absent reviews every action. */
  actions: z.array(z.string().min(1)).optional(),
};

const ModelGuardEntry = z.strictObject({
  type: z.literal("model"),
  ...Scope,
  policy: z.string().min(1),
  model: z.strictObject({
    provider: z.enum([
      "anthropic",
      "openai",
      "openrouter",
      "openai-compatible",
    ]),
    id: z.string().min(1),
    baseUrl: z.url().optional(),
    /** Environment variable holding the key; defaults per provider. */
    apiKeyEnv: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]*$/)
      .optional(),
  }),
});

const ApprovalGuardEntry = z.strictObject({
  type: z.literal("approval"),
  ...Scope,
  reason: z.string().min(1).optional(),
});

const GatewayFile = z.strictObject({
  connections: z
    .array(z.union([HttpEntry, PostgresEntry, McpEntry]))
    .default([]),
  guards: z.array(z.union([ModelGuardEntry, ApprovalGuardEntry])).default([]),
});

type ParsedConnection = z.infer<typeof GatewayFile>["connections"][number];
type ParsedMcp = Extract<ParsedConnection, { type: "mcp" }>;

/** A gateway connection, with any client secret read from the environment. */
export type GatewayConnectionConfig =
  | Exclude<ParsedConnection, { type: "mcp" }>
  | (Omit<ParsedMcp, "oauth"> & {
      oauth?: { client: { id: string; secret?: string; scopes?: string[] } };
    });

export type GatewayGuardConfig =
  | (Omit<z.infer<typeof ModelGuardEntry>, "model"> & {
      model: {
        provider: z.infer<typeof ModelGuardEntry>["model"]["provider"];
        id: string;
        baseUrl?: string;
        apiKey?: string;
      };
    })
  | z.infer<typeof ApprovalGuardEntry>;

/** Connections and the guards that review them (ADRs 0162, 0163). */
export interface GatewayConfig {
  connections: GatewayConnectionConfig[];
  guards: GatewayGuardConfig[];
}

const DEFAULT_KEY_ENV = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
} as const;

/** Read `WORK_GATEWAY_CONFIG`, resolving model keys from the environment. */
export function gatewayConfigFromFile(args: {
  path: string;
  env: Record<string, string | undefined>;
}): GatewayConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(args.path, "utf8"));
  } catch (error) {
    throw new Error(
      `Could not read the gateway configuration at ${args.path}`,
      {
        cause: error,
      },
    );
  }
  const parsed = GatewayFile.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Invalid gateway configuration at ${args.path}: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  return {
    connections: parsed.data.connections.map(
      (entry): GatewayConnectionConfig => {
        if (entry.type !== "mcp" || !entry.oauth) return entry;
        const { secretEnv, ...client } = entry.oauth.client;
        const secret = secretEnv ? args.env[secretEnv] : undefined;
        if (secretEnv && !secret) {
          throw new Error(
            `Connection '${entry.kind}' needs its OAuth client secret in ${secretEnv}`,
          );
        }
        return {
          ...entry,
          oauth: { client: { ...client, ...(secret ? { secret } : {}) } },
        };
      },
    ),
    guards: parsed.data.guards.map((guard): GatewayGuardConfig => {
      if (guard.type !== "model") return guard;
      const keyEnv =
        guard.model.apiKeyEnv ??
        (guard.model.provider === "openai-compatible"
          ? undefined
          : DEFAULT_KEY_ENV[guard.model.provider]);
      const apiKey = keyEnv ? args.env[keyEnv] : undefined;
      // A self-hosted classifier may need no key at all.
      if (!apiKey && guard.model.provider !== "openai-compatible") {
        throw new Error(
          `Guard '${guard.name}' needs its model key in ${keyEnv ?? "the variable named by apiKeyEnv"}`,
        );
      }
      if (
        guard.model.provider === "openai-compatible" &&
        !guard.model.baseUrl
      ) {
        throw new Error(`Guard '${guard.name}' needs model.baseUrl`);
      }
      const { apiKeyEnv: _keyEnv, ...model } = guard.model;
      return {
        ...guard,
        model: { ...model, ...(apiKey ? { apiKey } : {}) },
      };
    }),
  };
}

/** A gateway provider; pooled ones close what they hold on shutdown. */
export type GatewayProvider = ConnectionProvider & {
  close?: () => Promise<void>;
};

export function gatewayProviders(
  config: GatewayConfig,
): readonly GatewayProvider[] {
  return config.connections.map((entry): GatewayProvider => {
    if (entry.type === "http") {
      return defineHttpApiConnectionProvider({
        kind: entry.kind,
        displayName: entry.displayName,
        baseUrl: entry.baseUrl,
        ...(entry.auth ? { auth: entry.auth } : {}),
        ...(entry.paths ? { paths: entry.paths } : {}),
        ...(entry.actions ? { actions: entry.actions } : {}),
        ...(entry.maxResponseBytes
          ? { maxResponseBytes: entry.maxResponseBytes }
          : {}),
        ...(entry.timeoutMs ? { timeoutMs: entry.timeoutMs } : {}),
      });
    }
    if (entry.type === "postgres") {
      const { type: _type, ...options } = entry;
      return definePostgresConnectionProvider(options);
    }
    const client = entry.oauth?.client;
    const provider = defineMcpConnectionProvider({
      kind: entry.kind,
      displayName: entry.displayName,
      server: { transport: entry.transport, url: entry.url },
      ...(client
        ? {
            oauth: {
              client: {
                clientId: client.id,
                ...(client.secret ? { clientSecret: client.secret } : {}),
                ...(client.scopes ? { scopes: client.scopes } : {}),
              },
            },
          }
        : {}),
    });
    return {
      ...provider,
      listActions: async (input: Parameters<typeof provider.listActions>[0]) =>
        (await provider.listActions(input)).map((action) => ({
          ...action,
          inputSchema: z.json().parse(action.inputSchema),
          annotations: action.annotations
            ? z.json().parse(action.annotations)
            : undefined,
        })),
      invoke: async (input: Parameters<typeof provider.invoke>[0]) =>
        z.json().parse(await provider.invoke(input)),
    };
  });
}

export function gatewayGuards(
  config: GatewayConfig,
  options: { model?: (guard: GatewayGuardConfig) => LanguageModel } = {},
): readonly ConnectionActionGuard[] {
  return config.guards.map((guard) => {
    const scope = {
      name: guard.name,
      ...(guard.kinds ? { kinds: guard.kinds } : {}),
      ...(guard.actions ? { actions: guard.actions } : {}),
    };
    if (guard.type === "approval") {
      return defineApprovalGuard({
        ...scope,
        ...(guard.reason ? { reason: guard.reason } : {}),
      });
    }
    return defineModelGuard({
      ...scope,
      policy: guard.policy,
      model: options.model?.(guard) ?? guardModel(guard.model),
    });
  });
}

function guardModel(model: {
  provider: "anthropic" | "openai" | "openrouter" | "openai-compatible";
  id: string;
  baseUrl?: string;
  apiKey?: string;
}): LanguageModel {
  if (model.provider === "anthropic") {
    return createAnthropic({ apiKey: model.apiKey })(model.id);
  }
  if (model.provider === "openai") {
    return createOpenAI({ apiKey: model.apiKey })(model.id);
  }
  // OpenRouter and self-hosted classifiers speak Chat Completions.
  return createOpenAI({
    apiKey: model.apiKey ?? "none",
    baseURL: model.baseUrl ?? "https://openrouter.ai/api/v1",
  }).chat(model.id);
}
