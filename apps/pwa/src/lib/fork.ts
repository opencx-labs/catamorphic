import type { Item } from "@catamorphic/react";

/**
 * The mirror-fork notice (ADR 0062): once a desktop session was continued
 * on its linked server, the desktop writes a `mirror_fork` notice into its
 * local copy. Clients then treat the stale copy as read-only history and
 * point at the live fork.
 */
export interface MirrorForkNotice {
  serverUrl: string;
  remoteProjectId: string;
  sessionId: string;
}

export function mirrorForkNotice(
  items: readonly Item[],
): MirrorForkNotice | null {
  for (const item of items) {
    if (item.kind !== "notice" || item.code !== "mirror_fork") continue;
    const { serverUrl, remoteProjectId, sessionId } = item.data;
    if (
      typeof serverUrl === "string" &&
      typeof remoteProjectId === "string" &&
      typeof sessionId === "string"
    )
      return { serverUrl, remoteProjectId, sessionId };
  }
  return null;
}
