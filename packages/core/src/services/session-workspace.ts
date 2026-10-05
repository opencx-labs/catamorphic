import type { SandboxProvider } from "@catamorphic/sandbox";

/**
 * A chat's live workspace as a person working beside its agent reaches it
 * (ADR 0208): the sandbox its turns run in, through the same provider the
 * turns use, fenced to the chat's Allocation.
 */
export interface SessionWorkspaceHandle {
  provider: SandboxProvider;
  sandboxId: string;
  /** The project folder, absolute in the sandbox: commands run here. */
  projectDirectory: string;
  /** Work's own files beside the project (`.work-session`). */
  sessionDirectory: string;
}

/** Why a chat has no workspace a person can work in right now. */
export type SessionWorkspaceUnavailableReason =
  /** Given back while idle, or never started; a message starts it. */
  | "not_running"
  /** A turn or another server is preparing it this moment. */
  | "starting"
  | "closed"
  /** Its agent works in a folder of its machine, not a sandbox. */
  | "unsupported"
  /** This server cannot reach the machine that holds it. */
  | "unreachable";

export class SessionWorkspaceUnavailableError extends Error {
  constructor(
    readonly reason: SessionWorkspaceUnavailableReason,
    message: string,
  ) {
    super(message);
    this.name = "SessionWorkspaceUnavailableError";
  }
}

export const WORKSPACE_NOT_RUNNING_MESSAGE =
  "This chat's workspace is not running; send it a message to start it.";
