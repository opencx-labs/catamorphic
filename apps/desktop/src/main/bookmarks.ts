import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Browser bookmarks. Both project and profile-wide scopes support the same
 * recursive folder model. Pinning promotes a bookmark out of its project so
 * it follows the user across projects.
 * Stored as plain JSON at `<userData>/bookmarks.json`.
 */
export interface Bookmark {
  id: string;
  label: string;
  url: string;
  /** Folder id within the same scope, or undefined for root. */
  folderId?: string;
  /** Last observed page favicon. Imported entries may not have one yet. */
  faviconUrl?: string;
}

export interface BookmarkFolder {
  id: string;
  label: string;
  /** Parent folder id within the same scope, or undefined for root. */
  parentId?: string;
}

export interface ProjectBookmarks {
  folders: BookmarkFolder[];
  bookmarks: Bookmark[];
}

interface BookmarksFile {
  byProject: Record<string, ProjectBookmarks>;
  /** Profile-wide bookmark trees, keyed by profile id. */
  pinnedByProfile: Record<string, ProjectBookmarks>;
}

interface SerializedBookmarksFile {
  byProject?: Record<string, ProjectBookmarks>;
  pinnedByProfile?: Record<string, ProjectBookmarks | Bookmark[]>;
}

const EMPTY: ProjectBookmarks = { folders: [], bookmarks: [] };

export class BookmarksStore {
  private data: BookmarksFile;

  constructor(private readonly file: string) {
    this.data = this.load();
  }

  private load(): BookmarksFile {
    try {
      const raw: SerializedBookmarksFile = JSON.parse(
        fs.readFileSync(this.file, "utf-8"),
      );
      const pinnedByProfile = Object.fromEntries(
        Object.entries(raw.pinnedByProfile ?? {}).map(([profileId, value]) => [
          profileId,
          Array.isArray(value) ? { folders: [], bookmarks: value } : value,
        ]),
      );
      return {
        byProject: raw.byProject ?? {},
        pinnedByProfile,
      };
    } catch {
      return { byProject: {}, pinnedByProfile: {} };
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, `${JSON.stringify(this.data, null, 2)}\n`);
  }

  forProject(projectId: string): ProjectBookmarks {
    return this.data.byProject[projectId] ?? EMPTY;
  }

  pinned(profileId: string): ProjectBookmarks {
    return this.data.pinnedByProfile[profileId] ?? EMPTY;
  }

  addBookmark(
    projectId: string,
    input: {
      label: string;
      url: string;
      folderId?: string;
      faviconUrl?: string;
    },
  ): Bookmark {
    this.data.byProject[projectId] ??= { folders: [], bookmarks: [] };
    const scope = this.data.byProject[projectId];
    const bookmark: Bookmark = {
      id: randomUUID(),
      label: input.label.trim() || input.url,
      url: input.url,
      folderId: input.folderId,
      faviconUrl: input.faviconUrl,
    };
    scope.bookmarks.push(bookmark);
    this.save();
    return bookmark;
  }

  addFolder(
    projectId: string,
    label: string,
    parentId?: string,
  ): BookmarkFolder {
    this.data.byProject[projectId] ??= { folders: [], bookmarks: [] };
    const scope = this.data.byProject[projectId];
    const folder: BookmarkFolder = {
      id: randomUUID(),
      label: label.trim() || "New folder",
      parentId,
    };
    scope.folders.push(folder);
    this.save();
    return folder;
  }

  update(
    projectId: string,
    id: string,
    patch: { label?: string; url?: string; folderId?: string | null },
  ): void {
    const scope = this.data.byProject[projectId];
    const bookmark = scope?.bookmarks.find((candidate) => candidate.id === id);
    if (!bookmark) return;
    if (patch.label !== undefined) bookmark.label = patch.label;
    if (patch.url !== undefined) bookmark.url = patch.url;
    if (patch.folderId !== undefined) {
      bookmark.folderId = patch.folderId ?? undefined;
    }
    this.save();
  }

  remove(projectId: string, id: string): void {
    const scope = this.data.byProject[projectId];
    if (!scope) return;
    const folder = scope.folders.find((candidate) => candidate.id === id);
    if (folder) {
      scope.folders = scope.folders.filter((candidate) => candidate.id !== id);
      // Orphaned children move up one level rather than disappearing.
      for (const child of scope.folders) {
        if (child.parentId === id) child.parentId = folder.parentId;
      }
      for (const bookmark of scope.bookmarks) {
        if (bookmark.folderId === id) bookmark.folderId = folder.parentId;
      }
    } else {
      scope.bookmarks = scope.bookmarks.filter(
        (candidate) => candidate.id !== id,
      );
    }
    this.save();
  }

  /**
   * Bulk-add pinned bookmarks (the browser-import path). Exact-URL matches
   * against the profile's existing pinned list are skipped so re-importing
   * is idempotent. Returns how many were actually added.
   */
  importPinned(
    profileId: string,
    imported: {
      folders: Array<{ path: string[] }>;
      bookmarks: Array<{
        label: string;
        url: string;
        folderPath?: string[];
      }>;
    },
  ): number {
    const pinned = this.data.pinnedByProfile[profileId] ?? {
      folders: [],
      bookmarks: [],
    };
    this.data.pinnedByProfile[profileId] = pinned;
    const pathForFolder = (folder: BookmarkFolder): string[] => {
      const labels: string[] = [folder.label];
      const seen = new Set([folder.id]);
      let parentId = folder.parentId;
      while (parentId && !seen.has(parentId)) {
        seen.add(parentId);
        const parent = pinned.folders.find((entry) => entry.id === parentId);
        if (!parent) break;
        labels.unshift(parent.label);
        parentId = parent.parentId;
      }
      return labels;
    };
    const folderIds = new Map(
      pinned.folders.map((folder) => [
        JSON.stringify(pathForFolder(folder)),
        folder.id,
      ]),
    );
    const ensureFolder = (folderPath: string[]): string | undefined => {
      let parentId: string | undefined;
      for (let depth = 1; depth <= folderPath.length; depth += 1) {
        const path = folderPath.slice(0, depth);
        const key = JSON.stringify(path);
        const existingId = folderIds.get(key);
        if (existingId) {
          parentId = existingId;
          continue;
        }
        const folder: BookmarkFolder = {
          id: randomUUID(),
          label: path.at(-1) ?? "Folder",
          parentId,
        };
        pinned.folders.push(folder);
        folderIds.set(key, folder.id);
        parentId = folder.id;
      }
      return parentId;
    };
    for (const folder of imported.folders) ensureFolder(folder.path);
    const existing = new Map(
      pinned.bookmarks.map((bookmark) => [bookmark.url, bookmark]),
    );
    let added = 0;
    for (const item of imported.bookmarks) {
      if (!item.url) continue;
      const folderId = ensureFolder(item.folderPath ?? []);
      const existingBookmark = existing.get(item.url);
      if (existingBookmark) {
        // Repair imports made by the former flattening implementation on
        // the next import without disturbing an already-organized entry.
        if (!existingBookmark.folderId && folderId) {
          existingBookmark.folderId = folderId;
        }
        continue;
      }
      const bookmark: Bookmark = {
        id: randomUUID(),
        label: item.label.trim() || item.url,
        url: item.url,
        folderId,
      };
      pinned.bookmarks.push(bookmark);
      existing.set(item.url, bookmark);
      added += 1;
    }
    if (added > 0 || imported.folders.length > 0) this.save();
    return added;
  }

  /** Move a project bookmark to the profile-wide pinned list. */
  pin(projectId: string, profileId: string, id: string): void {
    const scope = this.data.byProject[projectId];
    const bookmark = scope?.bookmarks.find((candidate) => candidate.id === id);
    if (!scope || !bookmark) return;
    scope.bookmarks = scope.bookmarks.filter(
      (candidate) => candidate.id !== id,
    );
    this.data.pinnedByProfile[profileId] ??= {
      folders: [],
      bookmarks: [],
    };
    const pinned = this.data.pinnedByProfile[profileId];
    pinned.bookmarks.push({ ...bookmark, folderId: undefined });
    this.save();
  }

  /** Unpin back into the current project's root. */
  unpin(profileId: string, projectId: string, id: string): void {
    const pinned = this.data.pinnedByProfile[profileId] ?? EMPTY;
    const bookmark = pinned.bookmarks.find((candidate) => candidate.id === id);
    if (!bookmark) return;
    pinned.bookmarks = pinned.bookmarks.filter(
      (candidate) => candidate.id !== id,
    );
    this.data.byProject[projectId] ??= { folders: [], bookmarks: [] };
    const scope = this.data.byProject[projectId];
    scope.bookmarks.push({ ...bookmark, folderId: undefined });
    this.save();
  }

  /** Rename works in either scope — the caller may not know which. */
  rename(
    projectId: string,
    profileId: string,
    id: string,
    label: string,
  ): void {
    const trimmed = label.trim();
    if (!trimmed) return;
    const owned = this.data.byProject[projectId]?.bookmarks.find(
      (entry) => entry.id === id,
    );
    if (owned) {
      owned.label = trimmed;
      this.save();
      return;
    }
    const pinned = this.data.pinnedByProfile[profileId]?.bookmarks.find(
      (entry) => entry.id === id,
    );
    if (pinned) {
      pinned.label = trimmed;
      this.save();
    }
  }

  removePinned(profileId: string, id: string): void {
    const pinned = this.data.pinnedByProfile[profileId];
    if (!pinned) return;
    pinned.bookmarks = pinned.bookmarks.filter(
      (candidate) => candidate.id !== id,
    );
    this.save();
  }
}
