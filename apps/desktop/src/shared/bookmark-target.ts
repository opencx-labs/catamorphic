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
  /** Sibling to land before; omitted appends at the end of the folder. */
  beforeId?: string;
}

/**
 * Where a bookmark lives: the project's own list, the profile's pins that
 * follow it across projects, or its imported library.
 */
export type BookmarkScope = "project" | "pinned" | "library";

/** Reorder or reparent an existing bookmark or folder within one scope. */
export interface BookmarkMove {
  projectId: string;
  profileId: string;
  scope: BookmarkScope;
  id: string;
  /** New parent folder; null or omitted means the scope root. */
  folderId?: string | null;
  /** Sibling to land before; omitted appends at the end of the folder. */
  beforeId?: string;
}

/** Edit a bookmark where it lives: its name, its address and its folder. */
export interface BookmarkUpdate {
  projectId: string;
  profileId: string;
  scope: BookmarkScope;
  id: string;
  label?: string;
  url?: string;
  /** New folder within the same scope; null means the scope's root. */
  folderId?: string | null;
}

/** A bookmark, or a folder whose children move up one level. */
export interface BookmarkRemoval {
  projectId: string;
  profileId: string;
  scope: BookmarkScope;
  id: string;
}

/** Rename a bookmark folder where it lives. */
export interface BookmarkFolderRename {
  projectId: string;
  profileId: string;
  scope: BookmarkScope;
  id: string;
  label: string;
}
