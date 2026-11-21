/**
 * A member's own machines on a project's server and their Claude Code and
 * Codex sign-ins on them (ADRs 0213, 0340). Each harness signs in on the
 * machine with its own login, so the sign-in never leaves it: the desktop
 * shows the login's link, and either the one-time code it printed (Codex)
 * or a field for the code the sign-in page gives back (Claude Code).
 * Plain data shared by main and renderer.
 */

/** A harness a member signs in to on a machine. */
export type SignInHarness = "claude-code" | "codex";

export const SIGN_IN_HARNESSES: readonly SignInHarness[] = [
  "claude-code",
  "codex",
];

/** A harness as people read it, and the account its sign-in is of. */
export const SIGN_IN_HARNESS_NAMES: Record<
  SignInHarness,
  { name: string; account: string }
> = {
  "claude-code": { name: "Claude Code", account: "Claude" },
  codex: { name: "Codex", account: "ChatGPT" },
};

export type RemoteSignInState = "signed-in" | "signed-out";

export const REMOTE_MACHINE_STATE_LABELS = {
  starting: "Starting",
  stopping: "Stopping",
  stopped: "Stopped",
  resuming: "Resuming",
  disabled: "Disabled",
  lost: "Lost",
} as const;

export type RemoteMachineState = keyof typeof REMOTE_MACHINE_STATE_LABELS;

export function remoteMachineState(
  value: unknown,
): RemoteMachineState | undefined {
  if (
    value === "starting" ||
    value === "stopping" ||
    value === "stopped" ||
    value === "resuming" ||
    value === "disabled" ||
    value === "lost"
  )
    return value;
  return undefined;
}

/** A machine that runs only this member's work. */
export interface RemoteMachine {
  id: string;
  name: string;
  /** Connected to the server now. */
  available: boolean;
  state?: RemoteMachineState;
  /** Whether the member is signed in to each harness there. */
  signIns: Record<SignInHarness, RemoteSignInState>;
}

/** A started sign-in: where to finish it, how, and until when. */
export interface HarnessSignIn {
  attempt: string;
  verificationUrl: string;
  /** The one-time code to enter on the page, when the login printed one. */
  userCode?: string;
  /** The login waits for the code the page gives back. */
  expects?: "code";
  /** ISO time. */
  expiresAt: string;
}

export type HarnessSignInState =
  | "waiting"
  | "signed-in"
  | "failed"
  | "expired"
  | "cancelled";

export interface HarnessSignInStatus {
  state: HarnessSignInState;
  message?: string;
}
