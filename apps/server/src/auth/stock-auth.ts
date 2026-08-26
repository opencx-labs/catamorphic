import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { betterAuth } from "better-auth";
import { bearer, genericOAuth, mcp, username } from "better-auth/plugins";
import type { StockAuthConfig } from "./auth-config.js";
import type { StockAuthDatabase } from "./auth-database.js";

export interface StockAuthUser {
  id: string;
  email: string;
  emailVerified: boolean;
  name: string;
  username: string | null;
}

export interface StockAuthSession {
  token: string;
  user: StockAuthUser;
}

export interface StockAuth {
  migrate(): Promise<void>;
  createLocalUser(args: {
    username: string;
    name: string;
    password: string;
    email?: string;
  }): Promise<StockAuthUser>;
  signInUsername(args: {
    username: string;
    password: string;
  }): Promise<StockAuthSession>;
  resolveSession(args: { token: string }): Promise<StockAuthUser | null>;
  findUserById(args: { userId: string }): Promise<StockAuthUser | null>;
  resolveAccessToken(args: { authorization: string }): Promise<{
    userId: string;
    email: string;
    emailVerified: boolean;
    scopes: string[];
  } | null>;
  handler(request: Request): Promise<Response>;
  close(): Promise<void>;
}

export function createStockAuth(options: {
  database: StockAuthDatabase;
  baseURL: string;
  secret: string;
  config?: StockAuthConfig;
}): StockAuth {
  const config = options.config ?? {
    local: { enabled: true },
    providers: [],
    publicMethods: () => ({ local: true, providers: [] }),
  };
  const auth = betterAuth({
    baseURL: options.baseURL,
    secret: options.secret,
    database: options.database.database,
    emailAndPassword: { enabled: config.local.enabled },
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
        })),
      }),
      mcp({
        loginPage: `${options.baseURL}/login`,
        resource: `${options.baseURL}/api`,
        oidcConfig: {
          loginPage: `${options.baseURL}/login`,
          allowDynamicClientRegistration: true,
          requirePKCE: true,
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
      return stockAuthUser(result.user);
    },
    signInUsername: async (args) => {
      const result = await auth.api.signInUsername({ body: args });
      return {
        token: result.token,
        user: stockAuthUser(result.user),
      };
    },
    resolveSession: async ({ token }) => {
      const result = await auth.api.getSession({
        headers: new Headers({ authorization: `Bearer ${token}` }),
      });
      return result ? stockAuthUser(result.user) : null;
    },
    findUserById: async ({ userId }) => {
      const context = await auth.$context;
      const user = await context.internalAdapter.findUserById(userId);
      return user ? stockAuthUser(user) : null;
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

export function loadStockAuthSecret(options: {
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

function stockAuthUser(user: {
  id: string;
  email: string;
  emailVerified: boolean;
  name: string;
  username?: string | null;
}): StockAuthUser {
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
    throw new Error("The stock auth secret must be at least 32 characters");
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
