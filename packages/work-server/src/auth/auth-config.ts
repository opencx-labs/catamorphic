import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

const Domain = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/);
const ProviderId = z.string().regex(/^[a-z][a-z0-9_-]*$/);

const OidcProviderSchema = z.strictObject({
  kind: z.literal("oidc").default("oidc"),
  id: ProviderId,
  label: z.string().min(1),
  discoveryUrl: z.url(),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  scopes: z.array(z.string().min(1)).default(["openid", "email", "profile"]),
  allowedDomains: z.array(Domain).default([]),
  /**
   * `guests` sign people in only to view shares addressed to them (ADR
   * 0165): customers through their own identity provider. They never become
   * members and cannot use the API.
   */
  audience: z.enum(["members", "guests"]).default("members"),
});

const GoogleWorkspaceProviderSchema = z.strictObject({
  kind: z.literal("google-workspace"),
  id: ProviderId.default("google"),
  label: z.string().min(1).default("Google"),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  /** Workspace domains whose accounts may sign in (the ID token `hd`). */
  domains: z.array(Domain).min(1),
  directory: z
    .strictObject({
      credentials: z.union([
        z.strictObject({ keyFile: z.string().min(1) }),
        z.strictObject({ metadataServer: z.literal(true) }),
      ]),
      requiredGroups: z
        .array(z.string().trim().toLowerCase().min(3))
        .default([]),
    })
    .optional(),
});

const ConfigSchema = z
  .strictObject({
    local: z.strictObject({ enabled: z.boolean() }).default({ enabled: true }),
    providers: z
      .array(z.union([GoogleWorkspaceProviderSchema, OidcProviderSchema]))
      .default([]),
    sessions: z
      .strictObject({
        accessTokenMinutes: z.number().int().min(1).max(60).default(15),
        idleDays: z.number().int().min(1).max(14).default(14),
        maxDays: z.number().int().min(1).max(30).default(30),
      })
      .default({ accessTokenMinutes: 15, idleDays: 14, maxDays: 30 }),
    directory: z
      .strictObject({
        checkMinutes: z.number().int().min(1).max(15).default(5),
        graceMinutes: z.number().int().min(0).max(120).default(30),
      })
      .default({ checkMinutes: 5, graceMinutes: 30 }),
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
      if (provider.kind === "oidc") {
        const url = new URL(provider.discoveryUrl);
        if (url.protocol !== "https:" && !isLoopback(url.hostname)) {
          context.addIssue({
            code: "custom",
            path: ["providers", index, "discoveryUrl"],
            message: "OIDC discovery must use HTTPS except on loopback",
          });
        }
      }
    }
    if (config.sessions.idleDays > config.sessions.maxDays) {
      context.addIssue({
        code: "custom",
        path: ["sessions", "idleDays"],
        message: "The idle lifetime cannot exceed the maximum session age",
      });
    }
  });

const GOOGLE_DISCOVERY =
  "https://accounts.google.com/.well-known/openid-configuration";

/** One configured sign-in provider, normalized for Better Auth. */
export interface WorkSignInProvider {
  kind: "oidc" | "google-workspace";
  audience: "members" | "guests";
  id: string;
  label: string;
  discoveryUrl: string;
  clientId: string;
  clientSecret: string;
  scopes: string[];
  /** Verified email domains; empty allows any. */
  allowedDomains: string[];
  /** Google Workspace domains the ID token `hd` claim must name. */
  hostedDomains: string[];
  authorizationParams: Record<string, string>;
  directory?: {
    credentials: { keyFile: string } | { metadataServer: true };
    requiredGroups: string[];
  };
}

export interface WorkSessionPolicy {
  accessTokenSeconds: number;
  idleSeconds: number;
  maxAgeSeconds: number;
}

export interface WorkDirectoryPolicy {
  checkIntervalMs: number;
  graceMs: number;
}

export interface WorkAuthConfig {
  local: { enabled: boolean };
  providers: WorkSignInProvider[];
  sessions: WorkSessionPolicy;
  directory: WorkDirectoryPolicy;
  /** Sign-in choices: members see member providers; share viewers see all. */
  publicMethods(audience?: "members" | "shares"): {
    local: boolean;
    providers: Array<{ id: string; label: string }>;
  };
  /** Providers whose accounts are guests (ADR 0165). */
  guestProviderIds(): Set<string>;
}

export function loadWorkAuthConfig(options: {
  dataDir: string;
  configuredPath?: string;
}): WorkAuthConfig {
  const file =
    options.configuredPath ?? path.join(options.dataDir, "auth-config.json");
  let raw: unknown = {};
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") {
      throw new Error(`Could not read the sign-in configuration at ${file}`, {
        cause: error,
      });
    }
  }
  return parseWorkAuthConfig(raw, file);
}

export function parseWorkAuthConfig(
  raw: unknown,
  source = "sign-in configuration",
): WorkAuthConfig {
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Invalid sign-in configuration at ${source}: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  const data = parsed.data;
  const providers = data.providers.map(
    (provider): WorkSignInProvider =>
      provider.kind === "google-workspace"
        ? {
            kind: "google-workspace",
            audience: "members",
            id: provider.id,
            label: provider.label,
            discoveryUrl: GOOGLE_DISCOVERY,
            clientId: provider.clientId,
            clientSecret: provider.clientSecret,
            scopes: ["openid", "email", "profile"],
            allowedDomains: [],
            hostedDomains: provider.domains,
            // Google's account chooser offers only accounts in this domain;
            // the ID token check below is what enforces it.
            authorizationParams: {
              hd:
                provider.domains.length === 1 ? provider.domains.join("") : "*",
              prompt: "select_account",
            },
            ...(provider.directory
              ? {
                  directory: {
                    credentials: provider.directory.credentials,
                    requiredGroups: provider.directory.requiredGroups,
                  },
                }
              : {}),
          }
        : {
            kind: "oidc",
            audience: provider.audience,
            id: provider.id,
            label: provider.label,
            discoveryUrl: provider.discoveryUrl,
            clientId: provider.clientId,
            clientSecret: provider.clientSecret,
            scopes: provider.scopes,
            allowedDomains: provider.allowedDomains,
            hostedDomains: [],
            authorizationParams: {},
          },
  );
  return {
    local: data.local,
    providers,
    sessions: {
      accessTokenSeconds: data.sessions.accessTokenMinutes * 60,
      idleSeconds: data.sessions.idleDays * 86_400,
      maxAgeSeconds: data.sessions.maxDays * 86_400,
    },
    directory: {
      checkIntervalMs: data.directory.checkMinutes * 60_000,
      graceMs: data.directory.graceMinutes * 60_000,
    },
    publicMethods: (audience = "members") => ({
      local: data.local.enabled,
      providers: providers
        .filter(
          (provider) =>
            audience === "shares" || provider.audience === "members",
        )
        .map(({ id, label }) => ({ id, label })),
    }),
    guestProviderIds: () =>
      new Set(
        providers
          .filter((provider) => provider.audience === "guests")
          .map((provider) => provider.id),
      ),
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
