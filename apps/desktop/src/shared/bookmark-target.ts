/** Stable local chat links let bookmarks reopen conversations after tabs close. */
export function chatBookmarkUrl({
  projectId,
  sessionId,
}: {
  projectId: string;
  sessionId: string;
}): string {
  const url = new URL("catamorphic://chat");
  url.searchParams.set("project", projectId);
  url.searchParams.set("session", sessionId);
  return url.href;
}

export function parseChatBookmarkUrl(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== "catamorphic:" || url.hostname !== "chat") return null;
    const projectId = url.searchParams.get("project");
    const sessionId = url.searchParams.get("session");
    return projectId && sessionId ? { projectId, sessionId } : null;
  } catch {
    return null;
  }
}

export interface BookmarkPlacement {
  projectId: string;
  profileId: string;
  label: string;
  url: string;
  folderId?: string;
  pinned?: boolean;
}
