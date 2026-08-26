import { RemoteAuthError } from "./remote-sync.js";

export type RemoteConnectionState =
  | "connected"
  | "sign_in_required"
  | "access_removed"
  | "unreachable";

export interface RemoteConnectionStatus {
  state: RemoteConnectionState;
  checkedAt: string;
  message: string;
}

export async function probeRemoteConnection(options: {
  remoteProjectId: string;
  me(): Promise<{ projects: Array<{ projectId: string }> } | null>;
}): Promise<RemoteConnectionStatus> {
  const checkedAt = new Date().toISOString();
  try {
    const me = await options.me();
    if (!me) {
      return {
        state: "unreachable",
        checkedAt,
        message: "This server did not return compatible access information.",
      };
    }
    if (
      !me.projects.some(
        (project) => project.projectId === options.remoteProjectId,
      )
    ) {
      return {
        state: "access_removed",
        checkedAt,
        message: "Your account no longer has access to this project.",
      };
    }
    return {
      state: "connected",
      checkedAt,
      message: "Connected to the project server.",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      error instanceof RemoteAuthError ||
      /refresh failed|sign.?in|access token|expired|revoked|\b401\b/i.test(
        message,
      )
    ) {
      return {
        state: "sign_in_required",
        checkedAt,
        message: "Sign in again to reconnect this project.",
      };
    }
    return {
      state: "unreachable",
      checkedAt,
      message: "The project server could not be reached.",
    };
  }
}
