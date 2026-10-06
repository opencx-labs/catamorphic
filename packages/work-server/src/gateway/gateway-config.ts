import fs from "node:fs";
import type { ConnectionProvider } from "@catamorphic/core";
import { defineMcpConnectionProvider } from "@catamorphic/mcp";
import {
  defineGitConnectionProvider,
  defineHttpApiConnectionProvider,
  defineModelConnectionProvider,
  definePostgresConnectionProvider,
} from "@catamorphic/server-sdk";
import { z } from "zod";

const Kind = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/);

const EnvName = z.string().regex(/^[A-Z][A-Z0-9_]*$/);

/**
 * A remote MCP server. `oauth.client` names a client registered with the
 * server's authorization server in advance, for servers without dynamic
 * client registration; its redirect URI is this server's
 * `<public origin>/api/connection-authorizations/callback` (ADR 0172).
 */
function mcpEntry<Client extends z.ZodType>(client: Client) {
  return z.strictObject({
    type: z.literal("mcp").default("mcp"),
    kind: Kind,
    displayName: z.string().min(1),
    url: z.url(),
    transport: z.enum(["http", "sse"]).default("http"),
    oauth: z.strictObject({ client }).optional(),
  });
}

const McpClientFields = {
  id: z.string().min(1),
  scopes: z.array(z.string().min(1)).optional(),
};

/** In typed config the client carries its secret itself (ADR 0183). */
const McpEntry = mcpEntry(
  z.strictObject({
    ...McpClientFields,
    secret: z.string().min(1).optional(),
  }),
);

/** In the image's file the secret stays in the environment. */
const McpFileEntry = mcpEntry(
  z.strictObject({
    ...McpClientFields,
    /** Environment variable holding a confidential client's secret. */
    secretEnv: EnvName.optional(),
  }),
);

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

/**
 * An API reached through the gateway with a stored key (ADR 0162), by
 * agents' connection tools and, without `actions`, by code in sandboxes
 * (ADR 0212). `auth` names the header the key goes in, or `basic` for a
 * `user:password` key sent as HTTP Basic.
 */
const HttpEntry = z
  .strictObject({
    type: z.literal("http"),
    kind: Kind,
    displayName: z.string().min(1),
    baseUrl: z.url(),
    auth: z
      .union([
        z.strictObject({
          header: z.string().min(1),
          scheme: z.string().optional(),
        }),
        z.strictObject({ basic: z.literal(true) }),
      ])
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

/**
 * Any Git host reached over HTTPS with a stored username and password or
 * token (ADR 0175). Sandboxes fetch and push through the gateway; the
 * credential never leaves the control plane.
 */
const GitEntry = z.strictObject({
  type: z.literal("git"),
  kind: Kind,
  displayName: z.string().min(1),
  /** Remote base URL, e.g. `https://git.example.com/`. */
  baseUrl: z.url(),
});

/**
 * A model API reached by harnesses in sandboxes through the gateway (ADR
 * 0180), beside the built-in `anthropic` and `openai`: an OpenAI-compatible
 * server such as OpenRouter or a self-hosted model, or a provider at
 * another base URL. The key is the service connection's; an entry with a
 * built-in kind replaces it.
 */
const ModelEntry = z.strictObject({
  type: z.literal("model"),
  kind: Kind,
  displayName: z.string().min(1),
  api: z.enum(["anthropic", "openai"]),
  /** Where the API's paths go, e.g. `https://openrouter.ai/api/v1`. */
  baseUrl: z.url().optional(),
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

const Connections = [HttpEntry, PostgresEntry, GitEntry, ModelEntry] as const;

/**
 * The connections the gateway brokers (ADRs 0162, 0163): typed, serializable
 * data a custom server passes as `config.gateway`, validated at boot. It
 * declares mechanics only; policy on top of them is host code, passed as
 * `hooks.connectionGuards` (ADR 0183).
 */
export const GatewayConfigSchema = z.strictObject({
  connections: z.array(z.union([...Connections, McpEntry])).default([]),
});

/** `WORK_GATEWAY_CONFIG`: the same shape, with secrets named by variable. */
const GatewayFileSchema = z.strictObject({
  connections: z.array(z.union([...Connections, McpFileEntry])).default([]),
});

/** Gateway connections as a custom server writes them. */
export type GatewayConfig = z.input<typeof GatewayConfigSchema>;
/** Gateway connections after validation. */
export type ParsedGatewayConfig = z.output<typeof GatewayConfigSchema>;
export type GatewayConnectionConfig =
  ParsedGatewayConfig["connections"][number];

/** Validate code-built gateway config with the file's rules. */
export function parseGatewayConfig(
  input: GatewayConfig,
  source = "config.gateway",
): ParsedGatewayConfig {
  const parsed = GatewayConfigSchema.safeParse(input);
  if (!parsed.success) throw invalid(source, parsed.error);
  return parsed.data;
}

/**
 * Read `WORK_GATEWAY_CONFIG` into typed config, resolving each secret the
 * file names by environment variable into its value.
 */
export function gatewayConfigFromFile(args: {
  path: string;
  env: Record<string, string | undefined>;
}): ParsedGatewayConfig {
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
  const parsed = GatewayFileSchema.safeParse(raw);
  if (!parsed.success) throw invalid(args.path, parsed.error);
  return parseGatewayConfig(
    {
      connections: parsed.data.connections.map((entry) => {
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
      }),
    },
    args.path,
  );
}

function invalid(source: string, error: z.ZodError): Error {
  return new Error(
    `Invalid gateway configuration at ${source}: ${error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ")}`,
  );
}

/** A gateway provider; pooled ones close what they hold on shutdown. */
export type GatewayProvider = ConnectionProvider & {
  close?: () => Promise<void>;
};

export function gatewayProviders(
  config: ParsedGatewayConfig,
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
    if (entry.type === "model") {
      return defineModelConnectionProvider({
        kind: entry.kind,
        displayName: entry.displayName,
        api: entry.api,
        ...(entry.baseUrl ? { baseUrl: entry.baseUrl } : {}),
      });
    }
    if (entry.type === "git") {
      return defineGitConnectionProvider({
        kind: entry.kind,
        displayName: entry.displayName,
        baseUrl: entry.baseUrl,
      });
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
