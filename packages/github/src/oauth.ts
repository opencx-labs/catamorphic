import {
  type DeviceCodeGrant,
  type FetchLike,
  type GithubAppConfig,
  GithubAuthError,
  type GithubTokenSet,
} from "./types.js";

const GITHUB_BASE = "https://github.com";

interface OAuthTokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  error?: string;
  error_description?: string;
  interval?: number;
}

async function postForm(
  fetchImpl: FetchLike,
  url: string,
  params: Record<string, string>,
): Promise<OAuthTokenResponse> {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(params).toString(),
  });
  if (!response.ok) {
    throw new GithubAuthError(
      "http_error",
      `GitHub OAuth endpoint returned ${response.status}`,
    );
  }
  return (await response.json()) as OAuthTokenResponse;
}

function toTokenSet(data: OAuthTokenResponse, now: number): GithubTokenSet {
  if (!data.access_token) {
    throw new GithubAuthError(
      data.error ?? "unknown",
      data.error_description ?? "GitHub returned no access token",
    );
  }
  return {
    accessToken: data.access_token,
    expiresAt: data.expires_in ? now + data.expires_in * 1000 : null,
    refreshToken: data.refresh_token ?? null,
    refreshTokenExpiresAt: data.refresh_token_expires_in
      ? now + data.refresh_token_expires_in * 1000
      : null,
  };
}

/**
 * Start the device flow: GitHub hands back a short user code to display and
 * a verification URL to open in a browser. Requires "Enable Device Flow" on
 * the GitHub App; needs only the client id, so it is safe in public clients.
 */
export async function requestDeviceCode(
  app: GithubAppConfig,
  opts?: { fetch?: FetchLike; baseUrl?: string },
): Promise<DeviceCodeGrant> {
  const data = await postForm(
    opts?.fetch ?? fetch,
    `${opts?.baseUrl ?? GITHUB_BASE}/login/device/code`,
    { client_id: app.clientId },
  );
  const raw = data as unknown as {
    device_code?: string;
    user_code?: string;
    verification_uri?: string;
    expires_in?: number;
    interval?: number;
    error?: string;
    error_description?: string;
  };
  if (!raw.device_code || !raw.user_code || !raw.verification_uri) {
    throw new GithubAuthError(
      raw.error ?? "unknown",
      raw.error_description ?? "GitHub returned an incomplete device grant",
    );
  }
  return {
    deviceCode: raw.device_code,
    userCode: raw.user_code,
    verificationUri: raw.verification_uri,
    expiresIn: raw.expires_in ?? 900,
    interval: raw.interval ?? 5,
  };
}

/**
 * Poll once for the device-flow result. Returns null while the user has not
 * finished authorizing (`authorization_pending` / `slow_down` — on
 * `slow_down` wait the returned `retryAfter` seconds before the next poll).
 * Throws {@link GithubAuthError} on terminal failures (denied, expired).
 */
export async function pollDeviceToken(
  app: GithubAppConfig,
  deviceCode: string,
  opts?: { fetch?: FetchLike; baseUrl?: string; now?: number },
): Promise<{ tokens: GithubTokenSet } | { tokens: null; retryAfter: number }> {
  const data = await postForm(
    opts?.fetch ?? fetch,
    `${opts?.baseUrl ?? GITHUB_BASE}/login/oauth/access_token`,
    {
      client_id: app.clientId,
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    },
  );
  if (data.error === "authorization_pending") {
    return { tokens: null, retryAfter: 0 };
  }
  if (data.error === "slow_down") {
    return { tokens: null, retryAfter: data.interval ?? 5 };
  }
  return { tokens: toTokenSet(data, opts?.now ?? Date.now()) };
}

/** Build the browser URL for the web (authorization-code) flow. */
export function buildAuthorizeUrl(
  app: GithubAppConfig,
  opts: { redirectUri: string; state: string; baseUrl?: string },
): string {
  const url = new URL(`${opts.baseUrl ?? GITHUB_BASE}/login/oauth/authorize`);
  url.searchParams.set("client_id", app.clientId);
  url.searchParams.set("redirect_uri", opts.redirectUri);
  url.searchParams.set("state", opts.state);
  return url.toString();
}

/**
 * Exchange the authorization code from the web-flow callback for tokens.
 * Server-side only: requires the app's client secret.
 */
export async function exchangeCode(
  app: GithubAppConfig,
  args: { code: string; redirectUri?: string },
  opts?: { fetch?: FetchLike; baseUrl?: string; now?: number },
): Promise<GithubTokenSet> {
  if (!app.clientSecret) {
    throw new GithubAuthError(
      "missing_client_secret",
      "The web OAuth flow requires a client secret; use the device flow for public clients",
    );
  }
  const data = await postForm(
    opts?.fetch ?? fetch,
    `${opts?.baseUrl ?? GITHUB_BASE}/login/oauth/access_token`,
    {
      client_id: app.clientId,
      client_secret: app.clientSecret,
      code: args.code,
      ...(args.redirectUri ? { redirect_uri: args.redirectUri } : {}),
    },
  );
  return toTokenSet(data, opts?.now ?? Date.now());
}

/**
 * Refresh an expiring user token. Works with only the client id for
 * device-flow apps; include the secret when the app has one.
 */
export async function refreshAccessToken(
  app: GithubAppConfig,
  refreshToken: string,
  opts?: { fetch?: FetchLike; baseUrl?: string; now?: number },
): Promise<GithubTokenSet> {
  const data = await postForm(
    opts?.fetch ?? fetch,
    `${opts?.baseUrl ?? GITHUB_BASE}/login/oauth/access_token`,
    {
      client_id: app.clientId,
      ...(app.clientSecret ? { client_secret: app.clientSecret } : {}),
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    },
  );
  return toTokenSet(data, opts?.now ?? Date.now());
}

/**
 * Where users install the app / edit which repositories it can access.
 * GitHub shows the picker and redirects into the existing installation when
 * one already exists.
 */
export function buildInstallationUrl(app: GithubAppConfig): string {
  if (!app.appSlug) {
    throw new GithubAuthError(
      "missing_app_slug",
      "GithubAppConfig.appSlug is required to build the installation URL",
    );
  }
  return `https://github.com/apps/${app.appSlug}/installations/new`;
}

/** True when the token should be refreshed before use. */
export function isTokenStale(
  tokens: Pick<GithubTokenSet, "expiresAt">,
  now = Date.now(),
  skewMs = 60_000,
): boolean {
  return tokens.expiresAt !== null && tokens.expiresAt - skewMs <= now;
}
