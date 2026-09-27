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
  body?: string;
  headSha?: string;
  viewerLogin?: string;
  requestedReviewers?: string[];
  reviewRequestedForViewer?: boolean;
  reviewRequestsUnavailable?: boolean;

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

export type GithubReviewEvent = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";

/**
 * An inline review comment. `line` is the line in the diff's file (on the
 * `side` given, `RIGHT` for the new version by default); `startLine` makes
 * it a multi-line comment.
 */
export interface GithubReviewComment {
  path: string;
  body: string;
  line?: number;
  side?: "LEFT" | "RIGHT";
  startLine?: number;
  startSide?: "LEFT" | "RIGHT";
}

export interface GithubCheckRunAnnotation {
  path: string;
  startLine: number;
  endLine: number;
  level: "notice" | "warning" | "failure";
  message: string;
  title?: string;
}

/** Fields shared by creating and updating a check run. */
export interface GithubCheckRunFields {
  status?: "queued" | "in_progress" | "completed";
  conclusion?:
    | "action_required"
    | "cancelled"
    | "failure"
    | "neutral"
    | "success"
    | "skipped"
    | "timed_out";
  detailsUrl?: string;
  externalId?: string;
  /** ISO timestamps. */
  startedAt?: string;
  completedAt?: string;
  output?: {
    title: string;
    summary: string;
    text?: string;
    /** At most 50 per request (GitHub's limit). */
    annotations?: readonly GithubCheckRunAnnotation[];
  };
}

export interface GithubCheckRun {
  id: number;
  url: string | null;
  status: string;
  conclusion: string | null;
}

export interface GithubRepositoryEvent {
  id: string;
  /** GitHub's event class, for example PullRequestEvent. */
  type: string;
  actor: string | null;
  createdAt: string;
  /** Original GitHub payload. Normalization belongs to the event source. */
  payload: unknown;
}

/**
 * Server-side credentials of a GitHub App: what signs app JWTs. Distinct from
 * {@link GithubAppConfig}, which only identifies the app's OAuth client.
 */
export interface GithubAppCredentials {
  /** Numeric app ID, or the app's client ID; GitHub accepts both as issuer. */
  appId: string;
  /** PEM private key from the app's settings page (PKCS#1 or PKCS#8). */
  privateKey: string;
}

export type GithubPermissionLevel = "read" | "write" | "admin";

/** GitHub App permission names (`contents`, `pull_requests`, ...) to levels. */
export type GithubPermissions = Readonly<Record<string, GithubPermissionLevel>>;

/**
 * A short-lived installation access token (one hour). `repositories` lists
 * the full names it is limited to when the installation or the request
 * selected repositories; absent means every repository of the installation.
 */
export interface GithubInstallationToken {
  token: string;
  /** Epoch ms when the token stops working. */
  expiresAt: number;
  permissions: Record<string, string>;
  repositorySelection: "all" | "selected";
  repositories?: string[];
}

export interface GithubInstallation {
  id: number;
  /** The user or organization the app is installed on. */
  account: { login: string; id: number; type: string } | null;
  repositorySelection: "all" | "selected";
  permissions: Record<string, string>;
  events: string[];
  appSlug: string;
  suspendedAt: string | null;
}

/**
 * The app GitHub created at the end of the manifest flow. `privateKey`,
 * `clientSecret`, and `webhookSecret` are returned exactly once: store them
 * in the host's vault immediately.
 */
export interface GithubAppRegistration {
  appId: string;
  slug: string;
  name: string;
  owner: string | null;
  htmlUrl: string;
  clientId: string;
  clientSecret: string;
  webhookSecret: string | null;
  privateKey: string;
}

/** Any JSON value; structurally identical to hosts' JSON column types. */
export type GithubJson =
  | null
  | boolean
  | number
  | string
  | GithubJson[]
  | { [key: string]: GithubJson };

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
