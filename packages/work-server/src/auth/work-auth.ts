import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { betterAuth } from "better-auth";
import { bearer, genericOAuth, mcp, username } from "better-auth/plugins";
import { parseWorkAuthConfig, type WorkAuthConfig } from "./auth-config.js";
import type { WorkAuthDatabase } from "./auth-database.js";

export interface WorkAuthUser {
  id: string;
  email: string;
  emailVerified: boolean;
  name: string;
  username: string | null;
}

export interface WorkAuthSession {
  token: string;
  user: WorkAuthUser;
}

/** One OAuth token pair the authorization server issued. */
export interface WorkAuthGrant {
  id: string;
  userId: string;
  clientId: string;
}

/** Decides whether an upstream account may sign in (ADR 0161). */
export type WorkSignInGate = (args: {
  providerId: string;
  accountId: string;
  email: string;
}) => Promise<void>;

export interface WorkAuth {
  migrate(): Promise<void>;
  createLocalUser(args: {
    username: string;
    name: string;
    password: string;
    email?: string;
  }): Promise<WorkAuthUser>;
  signInUsername(args: {
    username: string;
    password: string;
  }): Promise<WorkAuthSession>;
  resolveSession(args: { token: string }): Promise<WorkAuthUser | null>;
  /** The browser session a request's cookies carry (share viewing). */
  sessionFromCookies(args: { cookie: string }): Promise<WorkAuthUser | null>;
  findUserById(args: { userId: string }): Promise<WorkAuthUser | null>;
  findUserByEmail(args: { email: string }): Promise<WorkAuthUser | null>;
  resolveAccessToken(args: { authorization: string }): Promise<{
    userId: string;
    email: string;
    emailVerified: boolean;
    scopes: string[];
  } | null>;
  /** The upstream accounts a user has signed in with. */
  accountsFor(args: {
    userId: string;
  }): Promise<Array<{ providerId: string; accountId: string }>>;
  grantByAccessToken(args: {
    accessToken: string;
  }): Promise<WorkAuthGrant | null>;
  grantByRefreshToken(args: {
    refreshToken: string;
  }): Promise<WorkAuthGrant | null>;
  deleteGrants(args: { ids: readonly string[] }): Promise<void>;
  /** Delete every token pair and browser session of one user. */
  signOutEverywhere(args: { userId: string }): Promise<void>;
  /** Users holding at least one unexpired refresh token. */
  /** Users holding a live OAuth grant or browser session. */
  usersSignedIn(): Promise<string[]>;
  handler(request: Request): Promise<Response>;
  close(): Promise<void>;
}

export function createWorkAuth(options: {
  database: WorkAuthDatabase;
  baseURL: string;
  secret: string;
  config?: WorkAuthConfig;
  /** Runs at every upstream sign-in after the provider's own checks. */
  signInGate?: WorkSignInGate;
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
        resource: `${options.baseURL}/api`,
        oidcConfig: {
          loginPage: `${options.baseURL}/login`,
          allowDynamicClientRegistration: true,
          requirePKCE: true,
          accessTokenExpiresIn: config.sessions.accessTokenSeconds,
          refreshTokenExpiresIn: config.sessions.idleSeconds,
          allowPlainCodeChallengeMethod: false,
          consentPage: `${options.baseURL}/oauth/consent`,
        },
      }),
    ],
  });

  return {
    migrate: () => options.database.migrate({ options: auth.options }),
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
      const result = await auth.api.getMcpSession({
        headers: new Headers({ authorization }),
      });
      if (!result?.userId) return null;
      const context = await auth.$context;
      const user = await context.internalAdapter.findUserById(result.userId);
      if (!user) return null;
      return {
        userId: result.userId,
        email: user.email,
        emailVerified: user.emailVerified,
        scopes: result.scopes.split(" ").filter(Boolean),
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
          where: [{ field: "accessToken", value: accessToken }],
        }),
      );
    },
    grantByRefreshToken: async ({ refreshToken }) => {
      const context = await auth.$context;
      return toGrant(
        await context.adapter.findOne({
          model: "oauthAccessToken",
          where: [{ field: "refreshToken", value: refreshToken }],
        }),
      );
    },
    deleteGrants: async ({ ids }) => {
      if (ids.length === 0) return;
      const context = await auth.$context;
      await context.adapter.deleteMany({
        model: "oauthAccessToken",
        where: [{ field: "id", operator: "in", value: [...ids] }],
      });
    },
    signOutEverywhere: async ({ userId }) => {
      const context = await auth.$context;
      await context.adapter.deleteMany({
        model: "oauthAccessToken",
        where: [{ field: "userId", value: userId }],
      });
      await context.internalAdapter.deleteUserSessions(userId);
    },
    usersSignedIn: async () => {
      const context = await auth.$context;
      const now = new Date();
      const [grants, sessions] = await Promise.all([
        context.adapter.findMany({
          model: "oauthAccessToken",
          where: [
            { field: "refreshTokenExpiresAt", operator: "gt", value: now },
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
