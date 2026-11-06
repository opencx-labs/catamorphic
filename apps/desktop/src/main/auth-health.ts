/**
 * Provider auth health, probed BEFORE a send fails (t3-code-inspired).
 * The point is the laptop-lid case: Claude Code's OAuth access token lives
 * ~8h; the refresh token ~29 days. An expired access token is fine (the
 * SDK refreshes silently), so the probe only reports what is KNOWABLY
 * wrong: no credentials at all, or a refresh token past its expiry — the
 * two states where the next send is guaranteed to fail and a re-login is
 * worth prompting for now, not after the failure.
 */

export type AgentAuthHealth = "ok" | "expired" | "missing";

/**
 * The agent-auth-health IPC answer. `reauth` is main's verdict on whether
 * a one-click re-login flow exists for the agent (account logins, local
 * claude-code/codex CLI sessions); the dock renders it verbatim and must
 * not re-derive the policy.
 */
export interface AgentAuthHealthReport {
  health: AgentAuthHealth;
  reauth: boolean;
}

/**
 * Health from the raw credential JSON (keychain entry or
 * .credentials.json). Unparseable content counts as missing — whatever is
 * there, the CLI won't be able to use it either.
 */
export function claudeOauthHealth(
  raw: string | null,
  now: number,
): AgentAuthHealth {
  if (!raw) return "missing";
  try {
    const oauth = (
      JSON.parse(raw) as {
        claudeAiOauth?: {
          accessToken?: unknown;
          refreshTokenExpiresAt?: unknown;
        };
      }
    ).claudeAiOauth;
    if (typeof oauth?.accessToken !== "string" || !oauth.accessToken) {
      return "missing";
    }
    // Number() covers both shapes seen in the wild: a number for
    // expiresAt, a numeric STRING for refreshTokenExpiresAt.
    const refreshEnd = Number(oauth.refreshTokenExpiresAt ?? 0);
    if (Number.isFinite(refreshEnd) && refreshEnd > 0 && refreshEnd < now) {
      return "expired";
    }
    return "ok";
  } catch {
    return "missing";
  }
}

/** The harnesses whose own sign-in Work reads on this machine. */
export type SignInHarness = "claude-code" | "codex";

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}

function filled(value: unknown): boolean {
  return typeof value === "string" && value.length > 0;
}

/**
 * Whether a harness's sign-in can still get itself a working access token
 * (ADR 0228): Claude Code's while it holds a refresh token that has not
 * expired, Codex's ChatGPT sign-in while it holds its refresh token. A
 * failure on such a sign-in may be passing (a refresh lost to another
 * process holding the lock, a network hiccup); without one, only signing
 * in again helps. Values are only checked for presence, never read out.
 */
export function signInRefreshable(input: {
  harness: SignInHarness;
  raw: string | null;
  now: number;
}): boolean {
  if (!input.raw) return false;
  try {
    const parsed = record(JSON.parse(input.raw));
    if (input.harness === "codex")
      return filled(record(parsed?.tokens)?.refresh_token);
    return (
      claudeOauthHealth(input.raw, input.now) === "ok" &&
      filled(record(parsed?.claudeAiOauth)?.refreshToken)
    );
  } catch {
    return false;
  }
}

/**
 * Whether a harness's sign-in can run a turn now: Claude Code's while its
 * refresh token lives, Codex's while it holds a key or its sign-in tokens.
 */
export function signInUsable(input: {
  harness: SignInHarness;
  raw: string | null;
  now: number;
}): boolean {
  if (input.harness === "claude-code")
    return claudeOauthHealth(input.raw, input.now) === "ok";
  if (!input.raw) return false;
  try {
    const parsed = record(JSON.parse(input.raw));
    return (
      filled(parsed?.OPENAI_API_KEY) ||
      filled(record(parsed?.tokens)?.access_token) ||
      filled(record(parsed?.tokens)?.refresh_token)
    );
  } catch {
    return false;
  }
}

/**
 * How near its expiry an access token stops counting as fresh: a CLI
 * refreshes one that close before using it, and a refresh is what failed.
 */
const FRESH_MARGIN_MS = 5 * 60_000;

/** A JWT's expiry (its `exp` claim) in milliseconds, or NaN. */
function jwtExpiry(token: unknown): number {
  if (typeof token !== "string") return Number.NaN;
  const payload = token.split(".")[1];
  if (!payload) return Number.NaN;
  const claims = record(
    JSON.parse(Buffer.from(payload, "base64url").toString("utf-8")),
  );
  return typeof claims?.exp === "number" ? claims.exp * 1000 : Number.NaN;
}

/**
 * Whether a harness's sign-in holds an access token a new CLI would use
 * as it is (ADR 0228): Claude Code's `expiresAt`, or the expiry of a Codex
 * sign-in's token, comfortably ahead. After a CLI was turned away with an
 * expired one, this means something refreshed it since. Only the expiry
 * is read.
 */
export function accessTokenFresh(input: {
  harness: SignInHarness;
  raw: string | null;
  now: number;
}): boolean {
  if (!input.raw) return false;
  try {
    const parsed = record(JSON.parse(input.raw));
    const expiresAt =
      input.harness === "codex"
        ? jwtExpiry(record(parsed?.tokens)?.access_token)
        : Number(record(parsed?.claudeAiOauth)?.expiresAt ?? Number.NaN);
    return (
      Number.isFinite(expiresAt) && expiresAt > input.now + FRESH_MARGIN_MS
    );
  } catch {
    return false;
  }
}
