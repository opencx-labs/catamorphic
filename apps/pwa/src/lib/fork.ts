/**
 * The mirror-fork marker (ADR 0062): once a desktop session was continued
 * on its linked server, the desktop stamps its local copy with a system
 * row carrying this marker. Clients then treat the stale copy as
 * read-only history and point at the live fork.
 */
export interface MirrorForkNotice {
  serverUrl: string;
  remoteProjectId: string;
  sessionId: string;
}

export function mirrorForkNotice(
  messages: Array<{ role: string; metadata?: unknown }>,
): MirrorForkNotice | null {
  for (const message of messages) {
    if (message.role !== "system") continue;
    const marker = (
      message.metadata as {
        marker?: {
          kind?: string;
          serverUrl?: string;
          remoteProjectId?: string;
          sessionId?: string;
        };
      } | null
    )?.marker;
    if (
      marker?.kind === "mirror_fork" &&
      typeof marker.serverUrl === "string" &&
      typeof marker.remoteProjectId === "string" &&
      typeof marker.sessionId === "string"
    ) {
      return {
        serverUrl: marker.serverUrl,
        remoteProjectId: marker.remoteProjectId,
        sessionId: marker.sessionId,
      };
    }
  }
  return null;
}
