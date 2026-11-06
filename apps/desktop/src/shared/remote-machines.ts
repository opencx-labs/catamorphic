/**
 * A member's own machines on a project's server and Codex sign-ins on them
 * (ADR 0213). Codex signs in on the machine with its device code login, so
 * the token never leaves it: the desktop only shows the one-time code.
 * Plain data shared by main and renderer.
 */

/** A machine that runs only this member's work. */
export interface RemoteMachine {
  id: string;
  name: string;
  /** Connected to the server now. */
  available: boolean;
  codex: "signed-in" | "signed-out";
}

/** A started sign-in: where to enter the code, and until when. */
export interface CodexSignIn {
  attempt: string;
  verificationUrl: string;
  userCode: string;
  /** ISO time. */
  expiresAt: string;
}

export type CodexSignInState =
  | "waiting"
  | "signed-in"
  | "failed"
  | "expired"
  | "cancelled";

export interface CodexSignInStatus {
  state: CodexSignInState;
  message?: string;
}
