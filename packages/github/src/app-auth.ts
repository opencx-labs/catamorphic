import {
  createHash,
  createPrivateKey,
  type KeyObject,
  sign,
} from "node:crypto";
import {
  type FetchLike,
  GithubApiError,
  type GithubAppCredentials,
  GithubAuthError,
  type GithubInstallation,
  type GithubInstallationToken,
  type GithubPermissions,
} from "./types.js";

const API_BASE = "https://api.github.com";
/** GitHub rejects app JWTs that live longer than ten minutes. */
const JWT_LIFETIME_SECONDS = 9 * 60;
/** Backdated issue time, tolerating clock drift against GitHub. */
const JWT_BACKDATE_SECONDS = 60;
const DEFAULT_REFRESH_SKEW_MS = 5 * 60_000;

/** Parse and check a GitHub App private key (PKCS#1 or PKCS#8 PEM). */
export function parseGithubAppPrivateKey(privateKey: string): KeyObject {
  let key: KeyObject;
  try {
    key = createPrivateKey(privateKey.trim());
  } catch {
    throw new GithubAuthError(
      "invalid_private_key",
      "The GitHub App private key is not a readable PEM key",
    );
  }
  if (key.asymmetricKeyType !== "rsa") {
    throw new GithubAuthError(
      "invalid_private_key",
      "A GitHub App private key must be an RSA key",
    );
  }
  return key;
}

/**
 * Sign a GitHub App JWT (RS256): issued a minute in the past, expiring nine
 * minutes from now, with the app ID (or client ID) as issuer. App JWTs only
 * authenticate `/app/...` endpoints, chiefly minting installation tokens.
 */
export function createGithubAppJwt(
  args: GithubAppCredentials & { now?: number },
): string {
  const seconds = Math.floor((args.now ?? Date.now()) / 1000);
  const appId = args.appId.trim();
  if (!appId) {
    throw new GithubAuthError("invalid_app_id", "A GitHub App ID is required");
  }
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iat: seconds - JWT_BACKDATE_SECONDS,
    exp: seconds + JWT_LIFETIME_SECONDS,
    iss: /^\d+$/.test(appId) ? Number(appId) : appId,
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = sign(
    "sha256",
    Buffer.from(signingInput),
    parseGithubAppPrivateKey(args.privateKey),
  );
  return `${signingInput}.${signature.toString("base64url")}`;
}

export interface GithubAppAuthOptions {
  fetch?: FetchLike;
  /** REST API base; GitHub Enterprise Server uses `https://HOST/api/v3`. */
  apiBaseUrl?: string;
  /** Clock, for tests. */
  now?: () => number;
  /** Tokens closer than this to expiry are minted again. Default 5 minutes. */
  refreshSkewMs?: number;
}

interface CachedToken {
  pending: Promise<GithubInstallationToken>;
  expiresAt?: number;
  appFingerprint: string;
}

interface RawInstallation {
  id: number;
  account: { login: string; id: number; type: string } | null;
  repository_selection: string;
  permissions?: Record<string, string>;
  events?: string[];
  app_slug: string;
  suspended_at: string | null;
}

interface RawInstallationToken {
  token: string;
  expires_at: string;
  permissions?: Record<string, string>;
  repository_selection?: string;
  repositories?: Array<{ full_name: string }>;
}

/**
 * GitHub App server-side authentication. Holds no credentials itself: every
 * call names the app, so one instance (and its token cache) can serve every
 * connection a host brokers. Installation tokens are cached per app key,
 * installation, repositories, and permissions, and minted again shortly
 * before they expire; concurrent requests share one mint.
 */
export class GithubAppAuth {
  private readonly fetch: FetchLike;
  private readonly apiBaseUrl: string;
  private readonly now: () => number;
  private readonly refreshSkewMs: number;
  private readonly tokens = new Map<string, CachedToken>();

  constructor(options: GithubAppAuthOptions = {}) {
    this.fetch = options.fetch ?? fetch;
    this.apiBaseUrl = (options.apiBaseUrl ?? API_BASE).replace(/\/+$/, "");
    this.now = options.now ?? Date.now;
    this.refreshSkewMs = options.refreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS;
  }

  appJwt(args: { app: GithubAppCredentials }): string {
    return createGithubAppJwt({ ...args.app, now: this.now() });
  }

  /**
   * An installation access token, optionally narrowed to repository names
   * (without the owner) and a subset of the installation's permissions.
   */
  async installationToken(args: {
    app: GithubAppCredentials;
    installationId: number;
    repositories?: readonly string[];
    permissions?: GithubPermissions;
  }): Promise<GithubInstallationToken> {
    requireInstallationId(args.installationId);
    const repositories = [
      ...new Set((args.repositories ?? []).map(repositoryName)),
    ].sort();
    const permissions = Object.entries(args.permissions ?? {}).sort(
      ([left], [right]) => left.localeCompare(right),
    );
    const appFingerprint = fingerprint(args.app);
    const key = JSON.stringify([
      appFingerprint,
      args.installationId,
      repositories,
      permissions,
    ]);
    const now = this.now();
    const cached = this.tokens.get(key);
    if (
      cached &&
      (cached.expiresAt === undefined ||
        cached.expiresAt - this.refreshSkewMs > now)
    ) {
      return cached.pending;
    }
    this.sweep(now);
    const entry: CachedToken = {
      appFingerprint,
      pending: this.mint({
        app: args.app,
        installationId: args.installationId,
        repositories,
        permissions: Object.fromEntries(permissions),
      }),
    };
    this.tokens.set(key, entry);
    try {
      const token = await entry.pending;
      entry.expiresAt = token.expiresAt;
      return token;
    } catch (error) {
      if (this.tokens.get(key) === entry) this.tokens.delete(key);
      throw error;
    }
  }

  /** Every installation of the app. */
  async listInstallations(args: {
    app: GithubAppCredentials;
  }): Promise<GithubInstallation[]> {
    const installations: GithubInstallation[] = [];
    for (let page = 1; ; page++) {
      const batch = await this.appRequest<RawInstallation[]>({
        app: args.app,
        path: `/app/installations?per_page=100&page=${page}`,
      });
      installations.push(...batch.map(mapInstallation));
      if (batch.length < 100) return installations;
    }
  }

  async installation(args: {
    app: GithubAppCredentials;
    installationId: number;
  }): Promise<GithubInstallation> {
    requireInstallationId(args.installationId);
    return mapInstallation(
      await this.appRequest<RawInstallation>({
        app: args.app,
        path: `/app/installations/${args.installationId}`,
      }),
    );
  }

  /**
   * The installation covering an owner (user or organization), or one
   * repository of it. Null when the app is not installed there.
   */
  async findInstallation(args: {
    app: GithubAppCredentials;
    owner: string;
    repository?: string;
  }): Promise<GithubInstallation | null> {
    const owner = segment(args.owner, "owner");
    const paths = args.repository
      ? [
          `/repos/${owner}/${segment(repositoryName(args.repository), "repository")}/installation`,
        ]
      : [`/orgs/${owner}/installation`, `/users/${owner}/installation`];
    for (const path of paths) {
      try {
        return mapInstallation(
          await this.appRequest<RawInstallation>({ app: args.app, path }),
        );
      } catch (error) {
        if (!(error instanceof GithubApiError && error.status === 404)) {
          throw error;
        }
      }
    }
    return null;
  }

  /**
   * Revoke and forget every cached installation token of an app, for example
   * when its connection is removed. Revocation is best-effort: tokens expire
   * within the hour regardless.
   */
  async revokeCachedTokens(args: { app: GithubAppCredentials }): Promise<void> {
    const appFingerprint = fingerprint(args.app);
    const entries = [...this.tokens].filter(
      ([, entry]) => entry.appFingerprint === appFingerprint,
    );
    for (const [key] of entries) this.tokens.delete(key);
    await Promise.all(
      entries.map(async ([, entry]) => {
        const token = await entry.pending.catch(() => null);
        if (!token || token.expiresAt <= this.now()) return;
        await this.fetch(`${this.apiBaseUrl}/installation/token`, {
          method: "DELETE",
          headers: headers(token.token),
        }).catch(() => undefined);
      }),
    );
  }

  private async mint(args: {
    app: GithubAppCredentials;
    installationId: number;
    repositories: readonly string[];
    permissions: Record<string, string>;
  }): Promise<GithubInstallationToken> {
    const raw = await this.appRequest<RawInstallationToken>({
      app: args.app,
      path: `/app/installations/${args.installationId}/access_tokens`,
      method: "POST",
      body: {
        ...(args.repositories.length
          ? { repositories: args.repositories }
          : {}),
        ...(Object.keys(args.permissions).length
          ? { permissions: args.permissions }
          : {}),
      },
    });
    const expiresAt = Date.parse(raw.expires_at);
    if (!raw.token || Number.isNaN(expiresAt)) {
      throw new GithubAuthError(
        "invalid_installation_token",
        "GitHub returned an incomplete installation token",
      );
    }
    return {
      token: raw.token,
      expiresAt,
      permissions: raw.permissions ?? {},
      repositorySelection:
        raw.repository_selection === "selected" ? "selected" : "all",
      ...(raw.repositories
        ? { repositories: raw.repositories.map((repo) => repo.full_name) }
        : {}),
    };
  }

  private async appRequest<T>(args: {
    app: GithubAppCredentials;
    path: string;
    method?: string;
    body?: unknown;
  }): Promise<T> {
    const response = await this.fetch(`${this.apiBaseUrl}${args.path}`, {
      method: args.method ?? "GET",
      headers: {
        ...headers(this.appJwt({ app: args.app })),
        ...(args.body !== undefined
          ? { "Content-Type": "application/json" }
          : {}),
      },
      ...(args.body !== undefined ? { body: JSON.stringify(args.body) } : {}),
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as {
        message?: string;
      };
      throw new GithubApiError(
        response.status,
        body.message ?? `GitHub API returned ${response.status}`,
      );
    }
    return (await response.json()) as T;
  }

  private sweep(now: number): void {
    for (const [key, entry] of this.tokens) {
      if (entry.expiresAt !== undefined && entry.expiresAt <= now) {
        this.tokens.delete(key);
      }
    }
  }
}

function headers(bearer: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${bearer}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

/**
 * Cache identity of an app: the private key is part of it, so material
 * naming someone else's app ID with a different key never reuses its tokens.
 */
function fingerprint(app: GithubAppCredentials): string {
  return createHash("sha256")
    .update(app.appId.trim())
    .update("\0")
    .update(app.privateKey.trim())
    .digest("hex");
}

function mapInstallation(raw: RawInstallation): GithubInstallation {
  return {
    id: raw.id,
    account: raw.account
      ? { login: raw.account.login, id: raw.account.id, type: raw.account.type }
      : null,
    repositorySelection:
      raw.repository_selection === "selected" ? "selected" : "all",
    permissions: raw.permissions ?? {},
    events: raw.events ?? [],
    appSlug: raw.app_slug,
    suspendedAt: raw.suspended_at,
  };
}

function requireInstallationId(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new GithubAuthError(
      "invalid_installation",
      "A GitHub App installation ID must be a positive integer",
    );
  }
}

/** `owner/name` or `name` → `name`, the form installation tokens take. */
function repositoryName(repository: string): string {
  const name = repository.trim().split("/").pop() ?? "";
  return segment(name.replace(/\.git$/, ""), "repository");
}

function segment(value: string, what: string): string {
  const trimmed = value.trim();
  if (!/^[\w.-]+$/.test(trimmed) || trimmed === "." || trimmed === "..") {
    throw new GithubApiError(400, `Invalid ${what}: ${value}`);
  }
  return trimmed;
}

function base64url(value: string): string {
  return Buffer.from(value).toString("base64url");
}
