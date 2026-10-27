import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { mcp } from "@better-auth/mcp";
import { verifyOAuthQueryParams } from "@better-auth/oauth-provider";
import { betterAuth } from "better-auth";
import { bearer, genericOAuth, username } from "better-auth/plugins";
import { z } from "zod";
import {
  parseWorkAuthConfig,
  type ResolvedWorkAuthConfig,
} from "./auth-config.js";
import type { WorkAuthDatabase } from "./auth-database.js";
import { CLIENT_ADDRESS_HEADER } from "./client-address.js";

import type {
  WorkAuth,
  WorkAuthGrant,
  WorkAuthUser,
  WorkSignInGate,
} from "./work-auth-types.js";

/** Provider sign-in starts per client address (Better Auth's window is seconds). */
const PROVIDER_SIGN_IN_LIMIT = { window: 10, max: 30 };

export function createWorkAuth(options: {
  database: WorkAuthDatabase;
  baseURL: string;
  secret: string;
  config?: ResolvedWorkAuthConfig;
  /** Runs at every upstream sign-in after the provider's own checks. */
  signInGate?: WorkSignInGate;
  /**
   * Per client address limits on the auth endpoints (default on). Requests
   * reach `handler` with the address in {@link CLIENT_ADDRESS_HEADER}.
   */
  rateLimit?: boolean;
}): WorkAuth {
  const config = options.config ?? parseWorkAuthConfig({});
  const auth = betterAuth({
    baseURL: options.baseURL,
    secret: options.secret,
    database: options.database.database,
    emailAndPassword: { enabled: config.local.enabled },
    // Browser sessions only carry a person through authorization; the
    // OAuth token family (ADR 0161) is the long-lived credential.
    session: { expiresIn: 12 * 3600, updateAge: 3600 },
    // A guest sign-in must never attach to a member with the same email
    // (ADR 0165), so accounts are never linked implicitly.
    account: { accountLinking: { enabled: false } },
    // Better Auth's own limits (3 sign-ins per 10 seconds, 100 requests to
    // any other endpoint) whatever NODE_ENV says, counted in the auth schema
    // so every replica spends one budget. The table exists either way.
    rateLimit: {
      enabled: options.rateLimit ?? true,
      storage: "database",
      // Starting a provider sign-in guesses nothing: the identity provider
      // authenticates. An office behind one address must not queue for it.
      customRules: {
        "/sign-in/social": PROVIDER_SIGN_IN_LIMIT,
      },
    },
    // The Work server resolves the client behind trusted proxies itself;
    // Better Auth sees only headers, never the connection's peer.
    advanced: {
      ipAddress: { ipAddressHeaders: [CLIENT_ADDRESS_HEADER] },
      // Work migrates under its own transaction/replica lock. An eager
      // vendor check would cache the old schema while that migration runs.
      database: { validateSchema: false },
    },
    plugins: [
      username(),
      bearer(),
      genericOAuth({
        config: config.providers.map((provider) => ({
          providerId: provider.id,
          discoveryUrl: provider.discoveryUrl,
          clientId: provider.clientId,
          clientSecret: provider.clientSecret,
          scopes: provider.scopes,
          pkce: true,
          authorizationUrlParams: provider.authorizationParams,
          mapProfileToUser: async (profile) => {
            assertOidcProfileAllowed(profile, provider.allowedDomains);
            assertHostedDomainAllowed(profile, provider.hostedDomains);
            const accountId =
              typeof profile.sub === "string" ? profile.sub : undefined;
            const email =
              typeof profile.email === "string" ? profile.email : undefined;
            if (options.signInGate && accountId && email) {
              await options.signInGate({
                providerId: provider.id,
                accountId,
                email,
              });
            }
            return {};
          },
        })),
      }),
      mcp({
        loginPage: `${options.baseURL}/login`,
        consentPage: `${options.baseURL}/oauth/consent`,
        resource: `${options.baseURL}/api`,
        // Work checks and revokes opaque grants on every request (ADR 0161).
        disableJwtPlugin: true,
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        clientRegistrationDefaultApplicationType: "infer",
        clientRegistrationRequirePKCE: true,
        grantTypes: ["authorization_code", "refresh_token"],
        accessTokenExpiresIn: config.sessions.accessTokenSeconds,
        refreshTokenExpiresIn: config.sessions.idleSeconds,
        refreshTokenReuseInterval: 0,
      }),
    ],
  });

  return {
    verifyAuthorizationQuery: ({ query }) =>
      verifyOAuthQueryParams(query, options.secret),
    migrate: async () => {
      await options.database.migrate({
        options: auth.options,
        resource: `${options.baseURL}/api`,
      });
      // Validate only after the schema and its data conversion have committed.
      await (await auth.$context).explicitSchemaCheck?.();
    },
    createLocalUser: async (args) => {
      if (!config.local.enabled) {
        throw new Error(
          "Local username and password authentication is disabled",
        );
      }
      const result = await auth.api.signUpEmail({
        body: {
          email: args.email ?? `${args.username}@local.invalid`,
          name: args.name,
          password: args.password,
          username: args.username,
        },
      });
      if (!args.email) return workAuthUser(result.user);
      // The operator creating a local account vouches for its email, so it
      // counts for memberships and shares addressed to it.
      const context = await auth.$context;
      const verified = await context.internalAdapter.updateUser(
        result.user.id,
        { emailVerified: true },
      );
      return workAuthUser(verified ?? result.user);
    },
    signInUsername: async (args) => {
      const result = await auth.api.signInUsername({ body: args });
      return {
        token: result.token,
        user: workAuthUser(result.user),
      };
    },
    resolveSession: async ({ token }) => {
      const result = await auth.api.getSession({
        headers: new Headers({ authorization: `Bearer ${token}` }),
      });
      return result ? workAuthUser(result.user) : null;
    },
    sessionFromCookies: async ({ cookie }) => {
      const result = await auth.api.getSession({
        headers: new Headers({ cookie }),
      });
      return result ? workAuthUser(result.user) : null;
    },
    findUserById: async ({ userId }) => {
      const context = await auth.$context;
      const user = await context.internalAdapter.findUserById(userId);
      return user ? workAuthUser(user) : null;
    },
    findUserByEmail: async ({ email }) => {
      const context = await auth.$context;
      const found = await context.internalAdapter.findUserByEmail(
        email.toLowerCase(),
      );
      return found ? workAuthUser(found.user) : null;
    },
    resolveAccessToken: async ({ authorization }) => {
      const bearerToken = /^Bearer ([^\s]+)$/i.exec(authorization)?.[1];
      if (!bearerToken) return null;
      const context = await auth.$context;
      const parsed = AccessGrant.safeParse(
        await context.adapter.findOne({
          model: "oauthAccessToken",
          where: [{ field: "token", value: authTokenHash(bearerToken) }],
        }),
      );
      if (!parsed.success) return null;
      const grant = parsed.data;
      if (
        !grant.userId ||
        grant.revoked ||
        !grant.resources?.includes(`${options.baseURL}/api`) ||
        grant.confirmation != null ||
        grant.expiresAt.getTime() <= Date.now()
      )
        return null;
      const client = z.object({ disabled: z.boolean().nullish() }).safeParse(
        await context.adapter.findOne({
          model: "oauthClient",
          where: [{ field: "clientId", value: grant.clientId }],
        }),
      );
      if (!client.success || client.data.disabled === true) return null;
      const user = await context.internalAdapter.findUserById(grant.userId);
      if (!user) return null;
      return {
        userId: grant.userId,
        email: user.email,
        emailVerified: user.emailVerified,
        scopes: grant.scopes,
      };
    },
    accountsFor: async ({ userId }) => {
      const context = await auth.$context;
      const accounts = await context.internalAdapter.findAccounts(userId);
      return accounts.map((account) => ({
        providerId: account.providerId,
        accountId: account.accountId,
      }));
    },
    grantByAccessToken: async ({ accessToken }) => {
      const context = await auth.$context;
      return toGrant(
        await context.adapter.findOne({
          model: "oauthAccessToken",
          where: [{ field: "token", value: authTokenHash(accessToken) }],
        }),
      );
    },
    grantByRefreshToken: async ({ refreshToken }) => {
      const context = await auth.$context;
      const refresh = z.object({ id: z.string() }).safeParse(
        await context.adapter.findOne({
          model: "oauthRefreshToken",
          where: [{ field: "token", value: authTokenHash(refreshToken) }],
        }),
      );
      if (!refresh.success) return null;
      return toGrant(
        await context.adapter.findOne({
          model: "oauthAccessToken",
          where: [{ field: "refreshId", value: refresh.data.id }],
        }),
      );
    },
    deleteGrants: async ({ ids }) => {
      if (ids.length === 0) return;
      const context = await auth.$context;
      const grants = await context.adapter.findMany({
        model: "oauthAccessToken",
        where: [{ field: "id", operator: "in", value: [...ids] }],
      });
      const refreshIds = grants.flatMap((grant) =>
        typeof grant === "object" &&
        grant !== null &&
        "refreshId" in grant &&
        typeof grant.refreshId === "string"
          ? [grant.refreshId]
          : [],
      );
      await context.adapter.deleteMany({
        model: "oauthAccessToken",
        where: [{ field: "id", operator: "in", value: [...ids] }],
      });
      if (refreshIds.length) {
        await context.adapter.deleteMany({
          model: "oauthAccessToken",
          where: [{ field: "refreshId", operator: "in", value: refreshIds }],
        });
        await context.adapter.deleteMany({
          model: "oauthRefreshToken",
          where: [{ field: "id", operator: "in", value: refreshIds }],
        });
      }
    },
    signOutEverywhere: async ({ userId }) => {
      const context = await auth.$context;
      await context.adapter.deleteMany({
        model: "oauthAccessToken",
        where: [{ field: "userId", value: userId }],
      });
      await context.adapter.deleteMany({
        model: "oauthRefreshToken",
        where: [{ field: "userId", value: userId }],
      });
      await context.internalAdapter.deleteUserSessions(userId);
    },
    usersSignedIn: async () => {
      const context = await auth.$context;
      const now = new Date();
      const [grants, sessions] = await Promise.all([
        context.adapter.findMany({
          model: "oauthRefreshToken",
          where: [
            { field: "expiresAt", operator: "gt", value: now },
            { field: "revoked", value: null },
          ],
        }),
        context.adapter.findMany({
          model: "session",
          where: [{ field: "expiresAt", operator: "gt", value: now }],
        }),
      ]);
      return [
        ...new Set([
          ...grants.flatMap((row) => {
            const grant = toGrant(row);
            return grant ? [grant.userId] : [];
          }),
          ...sessions.flatMap((row) =>
            typeof row === "object" &&
            row !== null &&
            "userId" in row &&
            typeof row.userId === "string"
              ? [row.userId]
              : [],
          ),
        ]),
      ];
    },
    handler: (request) => {
      const pathname = new URL(request.url).pathname;
      if (
        pathname === "/api/auth/sign-up/email" ||
        pathname === "/api/auth/update-user"
      ) {
        return Promise.resolve(new Response(null, { status: 404 }));
      }
      return auth.handler(request);
    },
    close: () => options.database.close(),
  };
}

const AccessGrant = z.object({
  id: z.string(),
  userId: z.string().nullish(),
  clientId: z.string(),
  expiresAt: z.coerce.date(),
  revoked: z.coerce.date().nullish(),
  scopes: z.array(z.string()),
  resources: z.array(z.string()).nullish(),
  confirmation: z.unknown().nullish(),
});

/** Better Auth's default opaque-token storage format. */
export function authTokenHash(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

function toGrant(row: unknown): WorkAuthGrant | null {
  if (typeof row !== "object" || row === null) return null;
  const id = "id" in row ? row.id : undefined;
  const userId = "userId" in row ? row.userId : undefined;
  const clientId = "clientId" in row ? row.clientId : undefined;
  return typeof id === "string" &&
    typeof userId === "string" &&
    typeof clientId === "string"
    ? { id, userId, clientId }
    : null;
}

/**
 * A Google Workspace account carries its organization's primary domain in
 * the ID token `hd` claim. A consumer Google account registered with a
 * company email address has no `hd`, so the email domain proves nothing.
 */
/**
 * The user who signs in with `email`, when that email is verified: an
 * identity provider proved it, or the operator who created the local
 * account vouched for it. How workflows name members by email (ADR 0210);
 * an unverified address names no one.
 */
export async function verifiedUserIdForEmail(input: {
  auth: Pick<WorkAuth, "findUserByEmail">;
  email: string;
}): Promise<string | null> {
  const user = await input.auth.findUserByEmail({ email: input.email });
  return user?.emailVerified ? user.id : null;
}

export function assertHostedDomainAllowed(
  profile: Record<string, unknown>,
  hostedDomains: readonly string[],
): void {
  if (hostedDomains.length === 0) return;
  const hd = typeof profile.hd === "string" ? profile.hd.toLowerCase() : "";
  const verified =
    profile.email_verified === true || profile.emailVerified === true;
  if (!verified) {
    throw new Error("This identity provider requires a verified email");
  }
  if (!hd || !hostedDomains.includes(hd)) {
    throw new Error("This account does not belong to an allowed Workspace");
  }
}

export function assertOidcProfileAllowed(
  profile: Record<string, unknown>,
  allowedDomains: readonly string[],
): void {
  if (allowedDomains.length === 0) return;
  const email = typeof profile.email === "string" ? profile.email : "";
  const verified =
    profile.email_verified === true || profile.emailVerified === true;
  if (!email || !verified) {
    throw new Error("This identity provider requires a verified email");
  }
  const domain = email.split("@").at(-1)?.toLowerCase();
  if (!domain || !allowedDomains.includes(domain)) {
    throw new Error(`The email domain '${domain ?? "unknown"}' is not allowed`);
  }
}

export function loadWorkAuthSecret(options: {
  dataDir: string;
  configuredSecret?: string;
}): string {
  if (options.configuredSecret) {
    assertSecretLength(options.configuredSecret);
    return options.configuredSecret;
  }

  fs.mkdirSync(options.dataDir, { recursive: true });
  const file = path.join(options.dataDir, "auth-secret");
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    assertSecretLength(existing);
    fs.chmodSync(file, 0o600);
    return existing;
  } catch (error) {
    if (isNodeError(error) && error.code !== "ENOENT") throw error;
  }

  const generated = randomBytes(32).toString("base64url");
  try {
    fs.writeFileSync(file, `${generated}\n`, { flag: "wx", mode: 0o600 });
    return generated;
  } catch (error) {
    if (!isNodeError(error) || error.code !== "EEXIST") throw error;
    const existing = fs.readFileSync(file, "utf8").trim();
    assertSecretLength(existing);
    fs.chmodSync(file, 0o600);
    return existing;
  }
}

function workAuthUser(user: {
  id: string;
  email: string;
  emailVerified: boolean;
  name: string;
  username?: string | null;
}): WorkAuthUser {
  return {
    id: user.id,
    email: user.email,
    emailVerified: user.emailVerified,
    name: user.name,
    username: user.username ?? null,
  };
}

function assertSecretLength(secret: string): void {
  if (secret.length < 32) {
    throw new Error(
      "The Work server auth secret must be at least 32 characters",
    );
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
