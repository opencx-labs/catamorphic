import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { z } from "zod";
import { orderedSiblings } from "../shared/bookmark-order.js";
import type {
  BookmarkMove,
  BookmarkPlacement,
} from "../shared/bookmark-target.js";
import { ConfigFile } from "./config-file.js";

/**
 * Browser bookmarks. Both project and profile-wide scopes support the same
 * recursive folder model. Pinning promotes a bookmark out of its project so
 * it follows the user across projects.
 * Stored as plain JSON at `<userData>/bookmarks.json`. Edits made to the
 * file outside the app (an agent adding a bookmark) load live.
 */
const bookmarkSchema = z.looseObject({
  id: z.string().min(1),
  label: z.string(),
  url: z.string(),
  /** Folder id within the same tree, or absent for its root. */
  folderId: z.string().optional(),
  /** Last observed page favicon. Imported entries may not have one yet. */
  faviconUrl: z.string().optional(),
  /** Order among all siblings (folders and bookmarks) under the same parent. */
  position: z.number().optional(),
});
const folderSchema = z.looseObject({
  id: z.string().min(1),
  label: z.string(),
  /** Parent folder id within the same tree, or absent for its root. */
  parentId: z.string().optional(),
  /** Order among all siblings (folders and bookmarks) under the same parent. */
  position: z.number().optional(),
});
const treeSchema = z.looseObject({
  folders: z.array(folderSchema).default([]),
  bookmarks: z.array(bookmarkSchema).default([]),
});
const bookmarksFileSchema = z.looseObject({
  /** A project's own tree (the sidebar's This project section). */
  byProject: z.record(z.string(), treeSchema).default({}),
  /** Bookmarks that follow a profile across projects. */
  pinnedByProfile: z.record(z.string(), treeSchema).default({}),
  /** A profile's imported browser bookmarks. */
  libraryByProfile: z.record(z.string(), treeSchema).default({}),
});

export type Bookmark = z.infer<typeof bookmarkSchema>;
export type BookmarkFolder = z.infer<typeof folderSchema>;
export type ProjectBookmarks = z.infer<typeof treeSchema>;
type BookmarksFile = z.infer<typeof bookmarksFileSchema>;

function parseBookmarksFile(raw: unknown): BookmarksFile {
  const parsed = bookmarksFileSchema.safeParse(raw);
  if (!parsed.success) throw new Error(z.prettifyError(parsed.error));
  return parsed.data;
}

const empty = (): ProjectBookmarks => ({ folders: [], bookmarks: [] });

const TREES = ["byProject", "pinnedByProfile", "libraryByProfile"] as const;

/** The keys whose trees differ between two versions of the file. */
function differs(
  a: Record<string, ProjectBookmarks>,
  b: Record<string, ProjectBookmarks>,
): string[] {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(
    (key) => JSON.stringify(a[key]) !== JSON.stringify(b[key]),
  );
}

/** Changes whenever the file is written or replaced; "" while it is missing. */
function fileStamp(file: string): string {
  try {
    const stat = fs.statSync(file);
    return `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return "";
  }
}

/** A tree of the file, created when a change first needs it. */
function tree(
  trees: Record<string, ProjectBookmarks>,
  key: string,
): ProjectBookmarks {
  trees[key] ??= empty();
  return trees[key];
}

/** Same site: scheme and a leading `www.` do not make it another one. */
function bookmarkSiteKey(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.host.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

/** Same page: also ignores a trailing slash and the fragment. */
function bookmarkPageKey(raw: string): string | undefined {
  const site = bookmarkSiteKey(raw);
  if (!site) return undefined;
  const url = new URL(raw);
  return `${site}${url.pathname.replace(/\/+$/, "")}${url.search}`;
}

/**
 * Put `id` before `beforeId` (or last) among the siblings of `parentId`, then
 * number every sibling in display order and keep both arrays sorted so
 * readers that walk them see the same order.
 */
function placeAmongSiblings(
  scope: ProjectBookmarks,
  id: string,
  parentId: string | undefined,
  beforeId: string | undefined,
): void {
  const kind = scope.folders.some((folder) => folder.id === id)
    ? ("folder" as const)
    : ("bookmark" as const);
  const siblings = orderedSiblings(scope, parentId).filter(
    (sibling) => sibling.id !== id,
  );
  const index = beforeId
    ? siblings.findIndex((sibling) => sibling.id === beforeId)
    : -1;
  const order =
    index < 0
      ? [...siblings, { id, kind }]
      : [...siblings.slice(0, index), { id, kind }, ...siblings.slice(index)];
  order.forEach((sibling, position) => {
    const entry =
      sibling.kind === "folder"
        ? scope.folders.find((folder) => folder.id === sibling.id)
        : scope.bookmarks.find((bookmark) => bookmark.id === sibling.id);
    if (entry) entry.position = position;
  });
  const byPosition = (a: { position?: number }, b: { position?: number }) =>
    (a.position ?? Number.MAX_SAFE_INTEGER) -
    (b.position ?? Number.MAX_SAFE_INTEGER);
  scope.folders.sort(byPosition);
  scope.bookmarks.sort(byPosition);
}

/** Which trees an outside edit changed, for the change broadcast. */
export interface BookmarksFileChange {
  projectIds: string[];
  profileIds: string[];
}

/**
 * The bookmarks file, read fresh for every question and every change, as
 * prefs, keybindings and the theme are (`ConfigFile`): a change reads the
 * file, applies itself and writes the result atomically, so an edit made
 * outside the app (an agent adding a bookmark) is never written over, and
 * a broken one is reported instead of replaced.
 */
export class BookmarksStore {
  private readonly config: ConfigFile;
  /** The file as last parsed, by its stat: unchanged files are not reparsed. */
  private cache: { stamp: string; data: BookmarksFile } | undefined;
  /** What windows have been told: by the watcher, or by a change's caller. */
  private announced: BookmarksFile;

  constructor(private readonly file: string) {
    this.config = new ConfigFile(file, parseBookmarksFile);
    this.announced = this.load();
  }

  /** Why the file is not applied, until it is fixed. */
  get error(): string | undefined {
    this.load();
    return this.config.error;
  }

  /** The file as it is now; its last valid content while it is broken. */
  private load(): BookmarksFile {
    const stamp = fileStamp(this.file);
    if (this.cache?.stamp !== stamp)
      this.cache = { stamp, data: parseBookmarksFile(this.config.read()) };
    return structuredClone(this.cache.data);
  }

  /**
   * One change: read the file, apply, and write the result back atomically
   * when something changed. A broken file is refused, never written over.
   * Windows hear of the change from its caller; an outside edit to other
   * trees since the last poll is still the watcher's to announce.
   */
  private edit<T>(apply: (data: BookmarksFile) => T): T {
    const data = this.load();
    if (this.config.error) throw new Error(this.config.error);
    const before = structuredClone(data);
    const result = apply(data);
    const changed = TREES.map(
      (trees) => [trees, differs(before[trees], data[trees])] as const,
    );
    if (changed.every(([, keys]) => keys.length === 0)) return result;
    this.config.write(data);
    const written = this.load();
    for (const [trees, keys] of changed)
      for (const key of keys) {
        const value = written[trees][key];
        if (value) this.announced[trees][key] = value;
        else delete this.announced[trees][key];
      }
    return result;
  }

  /**
   * Announce edits made outside the app. The file is polled by stat, not
   * watched through its directory: that is userData, where Chromium's
   * caches write constantly. Polling also follows an atomic save (write a
   * temporary file, rename it over this one). Every read and change goes
   * to the file itself, so a change made before the next poll already
   * builds on the edit; the poll only tells the windows.
   */
  watch(
    onChange: (change: BookmarksFileChange) => void,
    { intervalMs = 1000 }: { intervalMs?: number } = {},
  ): () => void {
    const poll = () => {
      const next = this.load();
      if (this.config.error) return;
      const before = this.announced;
      this.announced = next;
      const change = {
        projectIds: differs(before.byProject, next.byProject),
        profileIds: [
          ...new Set([
            ...differs(before.pinnedByProfile, next.pinnedByProfile),
            ...differs(before.libraryByProfile, next.libraryByProfile),
          ]),
        ],
      };
      if (change.projectIds.length > 0 || change.profileIds.length > 0)
        onChange(change);
    };
    fs.watchFile(this.file, { interval: intervalMs, persistent: false }, poll);
    return () => fs.unwatchFile(this.file, poll);
  }

  /** A project's tree with its profile's pinned and library trees, in one read. */
  trees({ projectId, profileId }: { projectId?: string; profileId: string }) {
    const data = this.load();
    return {
      project: projectId ? (data.byProject[projectId] ?? empty()) : null,
      pinned: data.pinnedByProfile[profileId] ?? empty(),
      library: data.libraryByProfile[profileId] ?? empty(),
    };
  }

  forProject(projectId: string): ProjectBookmarks {
    return this.load().byProject[projectId] ?? empty();
  }

  pinned(profileId: string): ProjectBookmarks {
    return this.load().pinnedByProfile[profileId] ?? empty();
  }

  library(profileId: string): ProjectBookmarks {
    return this.load().libraryByProfile[profileId] ?? empty();
  }

  /**
   * A visited page reported its icon. Bookmarks of that page take it;
   * bookmarks elsewhere on the same site take it only while they have
   * none (imported and synced entries arrive without one, and guessing
   * `/favicon.ico` misses every site that declares its icon in markup).
   * Returns the project ids whose bookmarks changed.
   */
  observeFavicon(input: {
    profileId: string;
    projectIds: readonly string[];
    url: string;
    faviconUrl: string;
  }): { projectIds: string[]; profileChanged: boolean } {
    const page = bookmarkPageKey(input.url);
    const site = bookmarkSiteKey(input.url);
    // A page's icon is not worth refusing over a broken file.
    if (!page || !site || !input.faviconUrl || this.error)
      return { projectIds: [], profileChanged: false };
    return this.edit((data) => {
      const apply = (scope: ProjectBookmarks | undefined): boolean => {
        let changed = false;
        for (const bookmark of scope?.bookmarks ?? []) {
          const samePage = bookmarkPageKey(bookmark.url) === page;
          const sameSite =
            !bookmark.faviconUrl && bookmarkSiteKey(bookmark.url) === site;
          if (!samePage && !sameSite) continue;
          if (bookmark.faviconUrl === input.faviconUrl) continue;
          bookmark.faviconUrl = input.faviconUrl;
          changed = true;
        }
        return changed;
      };
      const projectIds = input.projectIds.filter((projectId) =>
        apply(data.byProject[projectId]),
      );
      const pinnedChanged = apply(data.pinnedByProfile[input.profileId]);
      const libraryChanged = apply(data.libraryByProfile[input.profileId]);
      const profileChanged = pinnedChanged || libraryChanged;
      return { projectIds, profileChanged };
    });
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
    return this.edit((data) => {
      const scope = tree(data.byProject, projectId);
      const bookmark: Bookmark = {
        id: randomUUID(),
        label: input.label.trim() || input.url,
        url: input.url,
        ...(input.folderId ? { folderId: input.folderId } : {}),
        ...(input.faviconUrl ? { faviconUrl: input.faviconUrl } : {}),
        position: orderedSiblings(scope, input.folderId).length,
      };
      scope.bookmarks.push(bookmark);
      return bookmark;
    });
  }

  addFolder(
    projectId: string,
    label: string,
    parentId?: string,
  ): BookmarkFolder {
    return this.edit((data) => {
      const scope = tree(data.byProject, projectId);
      const folder: BookmarkFolder = {
        id: randomUUID(),
        label: label.trim() || "New folder",
        ...(parentId ? { parentId } : {}),
        position: orderedSiblings(scope, parentId).length,
      };
      scope.folders.push(folder);
      return folder;
    });
  }

  /** A drop moves an existing link or creates it once, in one saved mutation. */
  place({
    projectId,
    profileId,
    label,
    url,
    folderId,
    pinned = false,
    beforeId,
  }: BookmarkPlacement): Bookmark {
    return this.edit((data) => {
      const project = tree(data.byProject, projectId);
      const favorites = tree(data.pinnedByProfile, profileId);
      const destination = pinned ? favorites : project;
      if (
        folderId &&
        !destination.folders.some((folder) => folder.id === folderId)
      ) {
        throw new Error("This bookmark folder no longer exists.");
      }
      const existing =
        project.bookmarks.find((bookmark) => bookmark.url === url) ??
        favorites.bookmarks.find((bookmark) => bookmark.url === url) ??
        data.libraryByProfile[profileId]?.bookmarks.find(
          (bookmark) => bookmark.url === url,
        );
      const bookmark: Bookmark = {
        id: existing?.id ?? randomUUID(),
        label: existing?.label ?? (label.trim() || url),
        url,
        ...(folderId ? { folderId } : {}),
      };
      project.bookmarks = project.bookmarks.filter(
        (entry) => entry.url !== url,
      );
      favorites.bookmarks = favorites.bookmarks.filter(
        (entry) => entry.url !== url,
      );
      destination.bookmarks.push(bookmark);
      placeAmongSiblings(destination, bookmark.id, folderId, beforeId);
      return bookmark;
    });
  }

  /**
   * One drag model for every bookmark scope: a bookmark or folder lands
   * before any sibling (folder or bookmark), or last, inside a folder or at
   * the root. Siblings share one order regardless of kind.
   */
  move({ projectId, profileId, scope, id, folderId, beforeId }: BookmarkMove) {
    this.edit((data) => {
      const target =
        scope === "project"
          ? tree(data.byProject, projectId)
          : scope === "pinned"
            ? tree(data.pinnedByProfile, profileId)
            : tree(data.libraryByProfile, profileId);
      const parentId = folderId ?? undefined;
      if (parentId && !target.folders.some((folder) => folder.id === parentId))
        throw new Error("This bookmark folder no longer exists.");
      const folder = target.folders.find((entry) => entry.id === id);
      if (folder) {
        // A folder cannot move into itself or one of its descendants.
        for (let cursor = parentId; cursor; ) {
          if (cursor === id)
            throw new Error("A folder cannot be moved inside itself.");
          cursor = target.folders.find(
            (entry) => entry.id === cursor,
          )?.parentId;
        }
        setParent(folder, "parentId", parentId);
      } else {
        const bookmark = target.bookmarks.find((entry) => entry.id === id);
        if (!bookmark) throw new Error("This bookmark no longer exists.");
        setParent(bookmark, "folderId", parentId);
      }
      placeAmongSiblings(target, id, parentId, beforeId);
    });
  }

  update(
    projectId: string,
    id: string,
    patch: { label?: string; url?: string; folderId?: string | null },
  ): void {
    this.edit((data) => {
      const bookmark = data.byProject[projectId]?.bookmarks.find(
        (candidate) => candidate.id === id,
      );
      if (!bookmark) return;
      if (patch.label !== undefined) bookmark.label = patch.label;
      if (patch.url !== undefined) bookmark.url = patch.url;
      if (patch.folderId !== undefined)
        setParent(bookmark, "folderId", patch.folderId ?? undefined);
    });
  }

  remove(projectId: string, id: string): void {
    this.edit((data) => {
      const scope = data.byProject[projectId];
      if (!scope) return;
      removeEntry(scope, id);
    });
  }

  /**
   * Bulk-add explicit pinned bookmarks. Exact-URL matches
   * against the profile's existing pinned list are skipped so re-importing
   * is idempotent. Returns how many were actually added.
   */
  importPinned(profileId: string, imported: ImportedBookmarks): number {
    return this.edit((data) => {
      const added = importTree(tree(data.pinnedByProfile, profileId), imported);
      return added;
    });
  }

  /** Browser imports are saved in the library. Pinning is always explicit. */
  importBookmarks(profileId: string, imported: ImportedBookmarks): number {
    return this.edit((data) => {
      const added = importTree(
        tree(data.libraryByProfile, profileId),
        imported,
      );
      return added;
    });
  }

  /** Move a project bookmark to the profile-wide pinned list. */
  pin(projectId: string, profileId: string, id: string): void {
    this.edit((data) => {
      const scope = data.byProject[projectId];
      const bookmark =
        scope?.bookmarks.find((candidate) => candidate.id === id) ??
        data.libraryByProfile[profileId]?.bookmarks.find(
          (candidate) => candidate.id === id,
        );
      if (!bookmark) return;
      if (scope)
        scope.bookmarks = scope.bookmarks.filter(
          (candidate) => candidate.id !== id,
        );
      const pinned = tree(data.pinnedByProfile, profileId);
      if (!pinned.bookmarks.some((entry) => entry.id === id))
        pinned.bookmarks.push(atRoot(bookmark));
    });
  }

  /** Unpin back into the current project's root. */
  unpin(profileId: string, projectId: string, id: string): void {
    this.edit((data) => {
      const pinned = data.pinnedByProfile[profileId];
      const bookmark = pinned?.bookmarks.find(
        (candidate) => candidate.id === id,
      );
      if (!pinned || !bookmark) return;
      pinned.bookmarks = pinned.bookmarks.filter(
        (candidate) => candidate.id !== id,
      );
      if (
        !data.libraryByProfile[profileId]?.bookmarks.some(
          (entry) => entry.id === id,
        )
      )
        tree(data.byProject, projectId).bookmarks.push(atRoot(bookmark));
    });
  }

  /** Rename works in any scope: the caller may not know which. */
  rename(
    projectId: string,
    profileId: string,
    id: string,
    label: string,
  ): void {
    const trimmed = label.trim();
    if (!trimmed) return;
    this.edit((data) => {
      const entries = [
        data.libraryByProfile[profileId],
        data.byProject[projectId],
        data.pinnedByProfile[profileId],
      ].flatMap((scope) =>
        scope
          ? [...scope.bookmarks, ...scope.folders].filter(
              (entry) => entry.id === id,
            )
          : [],
      );
      if (entries.length === 0) return;
      for (const entry of entries) entry.label = trimmed;
    });
  }

  removeLibrary(profileId: string, id: string): void {
    this.edit((data) => {
      const scope = data.libraryByProfile[profileId];
      if (!scope) return;
      removeEntry(scope, id);
    });
  }

  removePinned(profileId: string, id: string): void {
    this.edit((data) => {
      const pinned = data.pinnedByProfile[profileId];
      if (!pinned) return;
      pinned.bookmarks = pinned.bookmarks.filter(
        (candidate) => candidate.id !== id,
      );
    });
  }
}

interface ImportedBookmarks {
  folders: Array<{ path: string[] }>;
  bookmarks: Array<{
    label: string;
    url: string;
    folderPath?: string[];
  }>;
}

/** Set or clear a parent reference; a cleared one leaves no key behind. */
function setParent<K extends "folderId" | "parentId">(
  entry: { [key in K]?: string },
  key: K,
  parentId: string | undefined,
): void {
  if (parentId) entry[key] = parentId;
  else delete entry[key];
}

/** A bookmark leaving its tree lands at the root of the next one. */
function atRoot(bookmark: Bookmark): Bookmark {
  const { folderId: _folderId, ...rest } = bookmark;
  return rest;
}

/** Remove a bookmark, or a folder whose children move up one level. */
function removeEntry(scope: ProjectBookmarks, id: string): void {
  const folder = scope.folders.find((candidate) => candidate.id === id);
  if (!folder) {
    scope.bookmarks = scope.bookmarks.filter(
      (candidate) => candidate.id !== id,
    );
    return;
  }
  scope.folders = scope.folders.filter((candidate) => candidate.id !== id);
  for (const child of scope.folders)
    if (child.parentId === id) setParent(child, "parentId", folder.parentId);
  for (const bookmark of scope.bookmarks)
    if (bookmark.folderId === id)
      setParent(bookmark, "folderId", folder.parentId);
}

/**
 * Merge an imported tree by folder path and URL; returns how many bookmarks
 * were new. A bookmark already present keeps its place, except that one at
 * the root takes the folder the import gives it.
 */
function importTree(target: ProjectBookmarks, imported: ImportedBookmarks) {
  const pathForFolder = (folder: BookmarkFolder): string[] => {
    const labels: string[] = [folder.label];
    const seen = new Set([folder.id]);
    let parentId = folder.parentId;
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId);
      const parent = target.folders.find((entry) => entry.id === parentId);
      if (!parent) break;
      labels.unshift(parent.label);
      parentId = parent.parentId;
    }
    return labels;
  };
  const folderIds = new Map(
    target.folders.map((folder) => [
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
        ...(parentId ? { parentId } : {}),
      };
      target.folders.push(folder);
      folderIds.set(key, folder.id);
      parentId = folder.id;
    }
    return parentId;
  };
  for (const folder of imported.folders) ensureFolder(folder.path);
  const existing = new Map(
    target.bookmarks.map((bookmark) => [bookmark.url, bookmark]),
  );
  let added = 0;
  for (const item of imported.bookmarks) {
    if (!item.url) continue;
    const folderId = ensureFolder(item.folderPath ?? []);
    const existingBookmark = existing.get(item.url);
    if (existingBookmark) {
      if (!existingBookmark.folderId && folderId)
        existingBookmark.folderId = folderId;
      continue;
    }
    const bookmark: Bookmark = {
      id: randomUUID(),
      label: item.label.trim() || item.url,
      url: item.url,
      ...(folderId ? { folderId } : {}),
    };
    target.bookmarks.push(bookmark);
    existing.set(item.url, bookmark);
    added += 1;
  }
  return added;
}
