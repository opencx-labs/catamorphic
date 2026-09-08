import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

const ProviderSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]*$/),
  label: z.string().min(1),
  discoveryUrl: z.url(),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  scopes: z.array(z.string().min(1)).default(["openid", "email", "profile"]),
  allowedDomains: z
    .array(
      z
        .string()
        .trim()
        .toLowerCase()
        .regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/),
    )
    .default([]),
});

const ConfigSchema = z
  .object({
    local: z.object({ enabled: z.boolean() }).default({ enabled: true }),
    providers: z.array(ProviderSchema).default([]),
  })
  .superRefine((config, context) => {
    const ids = new Set<string>();
    for (const [index, provider] of config.providers.entries()) {
      if (ids.has(provider.id)) {
        context.addIssue({
          code: "custom",
          path: ["providers", index, "id"],
          message: `Duplicate provider id '${provider.id}'`,
        });
      }
      ids.add(provider.id);
      const url = new URL(provider.discoveryUrl);
      if (url.protocol !== "https:" && !isLoopback(url.hostname)) {
        context.addIssue({
          code: "custom",
          path: ["providers", index, "discoveryUrl"],
          message: "OIDC discovery must use HTTPS except on loopback",
        });
      }
    }
  });

export type StockOidcProvider = z.infer<typeof ProviderSchema>;

export interface StockAuthConfig {
  local: { enabled: boolean };
  providers: StockOidcProvider[];
  publicMethods(): {
    local: boolean;
    providers: Array<{ id: string; label: string }>;
  };
}

export function loadStockAuthConfig(options: {
  dataDir: string;
  configuredPath?: string;
}): StockAuthConfig {
  const file =
    options.configuredPath ?? path.join(options.dataDir, "auth-config.json");
  let raw: unknown = {};
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") {
      throw new Error(`Could not read stock auth configuration at ${file}`, {
        cause: error,
      });
    }
  }
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Invalid stock auth configuration at ${file}: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  const data = parsed.data;
  return {
    local: data.local,
    providers: data.providers,
    publicMethods: () => ({
      local: data.local.enabled,
      providers: data.providers.map(({ id, label }) => ({ id, label })),
    }),
  };
}

function isLoopback(hostname: string): boolean {
  return (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]"
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
