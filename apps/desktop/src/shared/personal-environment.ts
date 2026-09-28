/**
 * A member's remote environment (ADR 0184): their own harness sign-ins and
 * chosen project files, sent by this desktop to a linked Work server for
 * their own sessions there. Plain data shared by main and renderer.
 */
export const PERSONAL_HARNESSES = ["claude-code", "codex"] as const;
export type PersonalHarness = (typeof PERSONAL_HARNESSES)[number];

export const PERSONAL_HARNESS_LABELS: Record<PersonalHarness, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
};

export function isPersonalHarness(value: unknown): value is PersonalHarness {
  return PERSONAL_HARNESSES.some((harness) => harness === value);
}

/** What the server says about this member's environment. */
export type PersonalEnvironmentServerState =
  /** Not asked yet. */
  | "unknown"
  /** Some Environment of the project allows personal credentials. */
  | "allowed"
  /** No Environment allows them; nothing is sent. */
  | "not-allowed"
  /** The server has no personal environment routes. */
  | "unsupported"
  /** The project's server sign-in expired. */
  | "sign-in"
  /** The server could not be reached. */
  | "unreachable";

export interface PersonalEnvironmentLoginView {
  harness: PersonalHarness;
  label: string;
  /** Listed in the config (or included by default). */
  included: boolean;
  /** Signed in on this computer. */
  available: boolean;
  /** The local sign-in's access expiry. */
  expiresAt: string | null;
  /** The copy the server holds, when it holds one. */
  server: {
    expiresAt: string | null;
    updatedAt: string;
    needsRefresh: boolean;
  } | null;
}

export interface PersonalEnvironmentFileView {
  path: string;
  bytes: number | null;
  /** Why the file cannot be sent (missing, too large, outside the project). */
  problem: string | null;
  server: { bytes: number; updatedAt: string } | null;
}

export interface PersonalEnvironmentView {
  projectId: string;
  /** Project-relative path of the config file. */
  configPath: string;
  configExists: boolean;
  configError: string | null;
  server: PersonalEnvironmentServerState;
  logins: PersonalEnvironmentLoginView[];
  files: PersonalEnvironmentFileView[];
  /** When this desktop last sent the environment. */
  lastSyncAt: string | null;
  /** When this desktop last asked the server. */
  lastCheckedAt: string | null;
  error: string | null;
  syncing: boolean;
}
