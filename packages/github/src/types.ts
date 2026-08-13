/**
 * Registration of a GitHub App (github.com → Settings → Developer settings).
 * Hosts bring their own app: catamorphic ships no client id. `clientSecret`
 * is only needed for the web authorization-code flow — device-flow-only hosts
 * (e.g. desktop apps, which cannot keep a secret) omit it.
 */
export interface GithubAppConfig {
  clientId: string;
  clientSecret?: string;
  /**
   * The app's URL slug (github.com/apps/<slug>). Needed to build the
   * installation URL where users grant repository access — OAuth
   * authorization alone identifies the user but grants no repos.
   */
  appSlug?: string;
}

/**
 * A user access token minted by a GitHub App. When the app has token
 * expiration enabled (the default), `refreshToken`/`expiresAt` are set and
 * the token must be refreshed via {@link refreshAccessToken} once stale.
 */
export interface GithubTokenSet {
  accessToken: string;
  /** Epoch ms when `accessToken` stops working; null for non-expiring. */
  expiresAt: number | null;
  refreshToken: string | null;
  /** Epoch ms when `refreshToken` itself expires; null when non-expiring. */
  refreshTokenExpiresAt: number | null;
}

export interface DeviceCodeGrant {
  deviceCode: string;
  /** Short code the user types at `verificationUri`. */
  userCode: string;
  verificationUri: string;
  /** Seconds until the device code expires. */
  expiresIn: number;
  /** Minimum seconds between poll attempts. */
  interval: number;
}

export interface GithubUser {
  login: string;
  id: number;
  avatarUrl: string;
  name: string | null;
}

export interface GithubRepo {
  id: number;
  /** e.g. `octocat/hello-world` */
  fullName: string;
  name: string;
  owner: string;
  private: boolean;
  defaultBranch: string;
  cloneUrl: string;
  description: string | null;
  /** ISO timestamp of the last push. */
  pushedAt: string | null;
}

export interface GithubPullRequest {
  number: number;
  title: string;
  url: string;
  author: string;
  /** Head branch name. */
  head: string;
  /** Base branch name. */
  base: string;
  draft: boolean;
  updatedAt: string;
}

export interface GithubPullRequestFile {
  path: string;
  /** added | modified | removed | renamed | … (GitHub's status values). */
  status: string;
  additions: number;
  deletions: number;
  /** Unified-diff hunk text; null for binary or oversized files. */
  patch: string | null;
  /** Set when status is "renamed". */
  previousPath?: string;
}

/**
 * A stored connection: the token set plus the GitHub identity it belongs to.
 * The login is denormalized so hosts can render "connected as X" without an
 * API round-trip.
 */
export interface StoredGithubConnection {
  tokens: GithubTokenSet;
  githubLogin: string;
  githubUserId: number;
}

/**
 * Host-owned persistence for GitHub connections. Catamorphic never stores
 * tokens itself — token custody follows the same rule as identity: the host
 * owns auth. Encryption at rest is the implementation's concern. Server
 * embedders typically back this with their own user table or secret manager;
 * the desktop app uses its OS-keychain-encrypted settings file.
 */
export interface GithubTokenStore {
  get(
    tenantId: string,
    externalUserId: string,
  ): Promise<StoredGithubConnection | null>;
  set(
    tenantId: string,
    externalUserId: string,
    connection: StoredGithubConnection,
  ): Promise<void>;
  delete(tenantId: string, externalUserId: string): Promise<void>;
}

export class GithubAuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "GithubAuthError";
  }
}

export class GithubApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GithubApiError";
  }
}

export type FetchLike = typeof fetch;
