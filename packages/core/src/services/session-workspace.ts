import type { DB } from "@catamorphic/db";
import type { SandboxProvider } from "@catamorphic/sandbox";
import { type Kysely, sql } from "kysely";

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

/** A person's use of a chat's workspace is recorded at most this often. */
export const WORKSPACE_USE_INTERVAL_SECONDS = 60;

/**
 * A person used the chat's workspace (ADR 0208): typed in or read a
 * terminal, or requested a preview. Idle release counts it as it counts a
 * turn. Written at most once a minute per chat, so following a terminal's
 * output costs a statement that changes nothing most of the time.
 */
export async function markWorkspaceUsed(input: {
  db: Kysely<DB>;
  sessionId: string;
}): Promise<void> {
  await input.db
    .insertInto("session_workspace_use")
    .values({ session_id: input.sessionId })
    .onConflict((conflict) =>
      conflict
        .column("session_id")
        .doUpdateSet({ used_at: sql<Date>`now()` })
        .where(
          "session_workspace_use.used_at",
          "<",
          sql<Date>`now() - make_interval(secs => ${WORKSPACE_USE_INTERVAL_SECONDS})`,
        ),
    )
    .execute();
}
