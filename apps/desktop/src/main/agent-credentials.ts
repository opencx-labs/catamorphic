import fs from "node:fs";
import path from "node:path";
import type { SignInHarness } from "./auth-health.js";
import { readClaudeKeychain } from "./harness-logins.js";

/**
 * Where an agent's own harness sign-in lives (ADR 0199): the machine's
 * Claude Code or Codex home (`local`), or the agent's private one
 * (`account`, named by its id).
 */
export interface AgentSignIn {
  harness: SignInHarness;
  auth: "local" | "account";
  id: string;
}

/** An agent's CLI credentials as this machine holds them. */
export interface AgentCredentials {
  present: boolean;
  /** Changes whenever the credentials do: a sign-in, a token refresh. */
  fingerprint: string;
  /** The credential document, for presence and expiry checks only. */
  raw: string | null;
}

export interface CredentialPlaces {
  /** The person's home: `~/.claude`, `~/.codex`. */
  homeDir: string;
  /** `agent-homes/`, where each account agent signs in on its own. */
  agentHomesDir: string;
}

/**
 * E2E seam: with the fake agent, every sign-in reads this file instead of
 * the machine's own, so a test can expire, refresh or replace a sign-in
 * without touching real credentials.
 */
function e2eCredentialsFile(): string | undefined {
  if (process.env.CATAMORPHIC_E2E_FAKE_AGENT !== "1") return undefined;
  return process.env.CATAMORPHIC_E2E_AGENT_CREDENTIALS || undefined;
}

/**
 * A change detector for the macOS Keychain's Claude Code login: a refresh
 * writes a new access token with a new expiry.
 */
export function claudeKeychainFingerprint(raw: string): string {
  try {
    const parsed: unknown = JSON.parse(raw);
    const oauth: unknown =
      typeof parsed === "object" && parsed !== null
        ? Reflect.get(parsed, "claudeAiOauth")
        : undefined;
    const expiresAt: unknown =
      typeof oauth === "object" && oauth !== null
        ? Reflect.get(oauth, "expiresAt")
        : undefined;
    return `keychain:${typeof expiresAt === "number" ? expiresAt : raw.length}`;
  } catch {
    return `keychain:${raw.length}`;
  }
}

/**
 * Where an agent's CLI credentials live: presence, a change fingerprint,
 * and the raw credential content (for health checks). On macOS, Claude
 * Code's default (~/.claude) login keeps its OAuth credentials in the
 * Keychain: there is no .credentials.json to stat. The values never leave
 * this machine (ADR 0199) and are never logged.
 */
export async function readAgentCredentials(
  agent: { harness: string; auth: string; id: string },
  places: CredentialPlaces,
): Promise<AgentCredentials> {
  const seam = e2eCredentialsFile();
  const home =
    agent.auth === "local"
      ? agent.harness === "codex"
        ? path.join(places.homeDir, ".codex")
        : path.join(places.homeDir, ".claude")
      : path.join(places.agentHomesDir, agent.id);
  const file =
    seam ??
    (agent.harness === "codex"
      ? path.join(home, "auth.json")
      : path.join(home, ".credentials.json"));
  try {
    const stat = fs.statSync(file);
    return {
      present: true,
      fingerprint: `file:${stat.mtimeMs}:${stat.size}`,
      raw: fs.readFileSync(file, "utf-8"),
    };
  } catch {
    // No file: the macOS keychain is the other place Claude Code keeps the
    // default account's session.
    if (!seam && agent.harness !== "codex" && agent.auth === "local") {
      const raw = await readClaudeKeychain();
      if (raw !== null)
        return {
          present: true,
          fingerprint: claudeKeychainFingerprint(raw),
          raw,
        };
    }
    return { present: false, fingerprint: "absent", raw: null };
  }
}
