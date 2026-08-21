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
