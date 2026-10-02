/**
 * A member's remote environment (ADR 0184): the project files they chose,
 * sent by this desktop to a linked Work server for their own sessions there.
 * Sign-ins stay on the machine they were made on (ADR 0198). Plain data
 * shared by main and renderer.
 */

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
  files: PersonalEnvironmentFileView[];
  /** When this desktop last sent the environment. */
  lastSyncAt: string | null;
  /** When this desktop last asked the server. */
  lastCheckedAt: string | null;
  error: string | null;
  syncing: boolean;
}
