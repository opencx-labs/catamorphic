import {
  type FetchLike,
  GithubApiError,
  type GithubAppRegistration,
  type GithubPermissions,
} from "./types.js";

const GITHUB_BASE = "https://github.com";
const API_BASE = "https://api.github.com";

/**
 * Permissions a self-registered app asks for by default: read repository
 * metadata and contents for sync, write branches, review and comment on pull
 * requests and issues, and report check runs. Hosts pass their own set when
 * they need less (or more).
 */
export const DEFAULT_GITHUB_APP_PERMISSIONS: GithubPermissions = {
  metadata: "read",
  contents: "write",
  pull_requests: "write",
  issues: "write",
  checks: "write",
};

/** Events matching the default permissions, subscribed when a webhook is set. */
export const DEFAULT_GITHUB_APP_EVENTS: readonly string[] = [
  "push",
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
  "issue_comment",
  "check_run",
  "check_suite",
];

export interface GithubAppManifestOptions {
  /** App name shown on GitHub; must be unique across GitHub. */
  name: string;
  /** Homepage of the host that owns the app. */
  url: string;
  description?: string;
  /** Where GitHub returns the browser with `?code=` after creating the app. */
  redirectUrl: string;
  /** User-authorization callback URLs, for member (user-to-server) OAuth. */
  callbackUrls?: readonly string[];
  /** Where GitHub sends people after they install the app. */
  setupUrl?: string;
  /** Webhook delivery URL; events are subscribed only when set. */
  webhookUrl?: string;
  /** Allow installation on other accounts. Default false. */
  public?: boolean;
  permissions?: GithubPermissions;
  events?: readonly string[];
  /** Ask for user authorization during installation. */
  requestOauthOnInstall?: boolean;
}

/** The JSON document GitHub's manifest flow takes (field names are GitHub's). */
export interface GithubAppManifest {
  name: string;
  url: string;
  description?: string;
  redirect_url: string;
  callback_urls?: string[];
  setup_url?: string;
  hook_attributes?: { url: string; active: boolean };
  public: boolean;
  default_permissions: Record<string, string>;
  default_events: string[];
  request_oauth_on_install?: boolean;
}

/**
 * Build the manifest for "Register your own app": an administrator submits it
 * to GitHub (see {@link githubAppManifestForm}), confirms the app name, and
 * GitHub redirects back with a code for {@link convertGithubAppManifest}.
 */
export function buildGithubAppManifest(
  options: GithubAppManifestOptions,
): GithubAppManifest {
  const name = options.name.trim();
  if (!name) throw new Error("A GitHub App name is required");
  return {
    name,
    url: options.url,
    ...(options.description ? { description: options.description } : {}),
    redirect_url: options.redirectUrl,
    ...(options.callbackUrls?.length
      ? { callback_urls: [...options.callbackUrls] }
      : {}),
    ...(options.setupUrl ? { setup_url: options.setupUrl } : {}),
    ...(options.webhookUrl
      ? { hook_attributes: { url: options.webhookUrl, active: true } }
      : {}),
    public: options.public ?? false,
    default_permissions: {
      ...(options.permissions ?? DEFAULT_GITHUB_APP_PERMISSIONS),
    },
    default_events: options.webhookUrl
      ? [...(options.events ?? DEFAULT_GITHUB_APP_EVENTS)]
      : [],
    ...(options.requestOauthOnInstall !== undefined
      ? { request_oauth_on_install: options.requestOauthOnInstall }
      : {}),
  };
}

/**
 * The browser form that starts the manifest flow. GitHub only accepts the
 * manifest as a form POST from the administrator's browser, so hosts render
 * `<form method="post" action={action}>` with one hidden `manifest` field.
 * `state` comes back on the redirect and must be checked by the host.
 */
export function githubAppManifestForm(args: {
  manifest: GithubAppManifest;
  state: string;
  /** Register under an organization instead of the signed-in user. */
  organization?: string;
  /** GitHub Enterprise Server web origin. Default `https://github.com`. */
  webBaseUrl?: string;
}): { action: string; fields: { manifest: string } } {
  const base = (args.webBaseUrl ?? GITHUB_BASE).replace(/\/+$/, "");
  if (args.organization && !/^[\w.-]+$/.test(args.organization)) {
    throw new Error(`Invalid organization: ${args.organization}`);
  }
  const action = new URL(
    args.organization
      ? `${base}/organizations/${args.organization}/settings/apps/new`
      : `${base}/settings/apps/new`,
  );
  action.searchParams.set("state", args.state);
  return {
    action: action.toString(),
    fields: { manifest: JSON.stringify(args.manifest) },
  };
}

interface RawConversion {
  id: number;
  slug: string;
  name: string;
  owner: { login: string } | null;
  html_url: string;
  client_id: string;
  client_secret: string;
  webhook_secret: string | null;
  pem: string;
}

/**
 * Exchange the manifest flow's one-hour code for the new app's credentials.
 * Unauthenticated by design: the code itself is the proof.
 */
export async function convertGithubAppManifest(args: {
  code: string;
  fetch?: FetchLike;
  apiBaseUrl?: string;
}): Promise<GithubAppRegistration> {
  if (!/^[\w-]+$/.test(args.code)) {
    throw new GithubApiError(400, "Invalid manifest code");
  }
  const base = (args.apiBaseUrl ?? API_BASE).replace(/\/+$/, "");
  const response = await (args.fetch ?? fetch)(
    `${base}/app-manifests/${args.code}/conversions`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      message?: string;
    };
    throw new GithubApiError(
      response.status,
      body.message ?? `GitHub API returned ${response.status}`,
    );
  }
  const raw = (await response.json()) as RawConversion;
  if (!raw.id || !raw.pem || !raw.client_id || !raw.client_secret) {
    throw new GithubApiError(502, "GitHub returned incomplete app credentials");
  }
  return {
    appId: String(raw.id),
    slug: raw.slug,
    name: raw.name,
    owner: raw.owner?.login ?? null,
    htmlUrl: raw.html_url,
    clientId: raw.client_id,
    clientSecret: raw.client_secret,
    webhookSecret: raw.webhook_secret ?? null,
    privateKey: raw.pem,
  };
}
