import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Browser bookmarks. Two scopes, Chrome-flavored but project-aware:
 *  - per-project bookmarks (folders supported, one level of nesting kept
 *    simple on purpose),
 *  - pinned bookmarks, which are profile-wide: pinning "promotes" a
 *    bookmark out of its project so it follows the user across projects.
 * Stored as plain JSON at `<userData>/bookmarks.json`.
 */
export interface Bookmark {
  id: string;
  label: string;
  url: string;
  /** Folder id within the same scope, or undefined for root. */
  folderId?: string;
}

export interface BookmarkFolder {
  id: string;
  label: string;
}

export interface ProjectBookmarks {
  folders: BookmarkFolder[];
  bookmarks: Bookmark[];
}

interface BookmarksFile {
  byProject: Record<string, ProjectBookmarks>;
  /** Profile-wide pinned bookmarks, keyed by profile id. */
  pinnedByProfile: Record<string, Bookmark[]>;
}

const EMPTY: ProjectBookmarks = { folders: [], bookmarks: [] };

export class BookmarksStore {
  private data: BookmarksFile;

  constructor(private readonly file: string) {
    this.data = this.load();
  }

  private load(): BookmarksFile {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf-8"));
      return {
        byProject: raw.byProject ?? {},
        pinnedByProfile: raw.pinnedByProfile ?? {},
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

  pinned(profileId: string): Bookmark[] {
    return this.data.pinnedByProfile[profileId] ?? [];
  }

  addBookmark(
    projectId: string,
    input: { label: string; url: string; folderId?: string },
  ): Bookmark {
    const scope = (this.data.byProject[projectId] ??= {
      folders: [],
      bookmarks: [],
    });
    const bookmark: Bookmark = {
      id: randomUUID(),
      label: input.label.trim() || input.url,
      url: input.url,
      folderId: input.folderId,
    };
    scope.bookmarks.push(bookmark);
    this.save();
    return bookmark;
  }

  addFolder(projectId: string, label: string): BookmarkFolder {
    const scope = (this.data.byProject[projectId] ??= {
      folders: [],
      bookmarks: [],
    });
    const folder: BookmarkFolder = {
      id: randomUUID(),
      label: label.trim() || "New folder",
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
      // Orphaned children fall back to root rather than disappearing.
      for (const bookmark of scope.bookmarks) {
        if (bookmark.folderId === id) bookmark.folderId = undefined;
      }
    } else {
      scope.bookmarks = scope.bookmarks.filter(
        (candidate) => candidate.id !== id,
      );
    }
    this.save();
  }

  /** Move a project bookmark to the profile-wide pinned list. */
  pin(projectId: string, profileId: string, id: string): void {
    const scope = this.data.byProject[projectId];
    const bookmark = scope?.bookmarks.find((candidate) => candidate.id === id);
    if (!scope || !bookmark) return;
    scope.bookmarks = scope.bookmarks.filter(
      (candidate) => candidate.id !== id,
    );
    const pinned = (this.data.pinnedByProfile[profileId] ??= []);
    pinned.push({ ...bookmark, folderId: undefined });
    this.save();
  }

  /** Unpin back into the current project's root. */
  unpin(profileId: string, projectId: string, id: string): void {
    const pinned = this.data.pinnedByProfile[profileId] ?? [];
    const bookmark = pinned.find((candidate) => candidate.id === id);
    if (!bookmark) return;
    this.data.pinnedByProfile[profileId] = pinned.filter(
      (candidate) => candidate.id !== id,
    );
    const scope = (this.data.byProject[projectId] ??= {
      folders: [],
      bookmarks: [],
    });
    scope.bookmarks.push(bookmark);
    this.save();
  }

  removePinned(profileId: string, id: string): void {
    const pinned = this.data.pinnedByProfile[profileId] ?? [];
    this.data.pinnedByProfile[profileId] = pinned.filter(
      (candidate) => candidate.id !== id,
    );
    this.save();
  }
}
