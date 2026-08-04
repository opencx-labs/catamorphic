import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  BrowserImporter,
  ImportableBrowser,
  ImportableProfile,
  ImportedBookmark,
  ImportedBookmarks,
} from "./types.js";

/**
 * Generic importer for Chromium-family browsers (Chrome, Edge, Brave, Arc,
 * Chromium). They all share the same on-disk layout:
 *
 *   <user-data-dir>/Local State          — JSON, profile.info_cache maps
 *                                          profile dir names to metadata,
 *   <user-data-dir>/<profile>/Bookmarks  — JSON tree under roots.bookmark_bar,
 *                                          roots.other and roots.synced.
 *
 * Everything here is defensive: missing or malformed files degrade to empty
 * results, never exceptions out of the public API.
 */

export interface ChromiumImporterOptions {
  id: string;
  label: string;
  /** User-data dir relative to the home directory, per platform. */
  darwinDir: string;
  linuxDir?: string;
  win32Dir?: string;
  /** Absolute path override for tests / portable installs. */
  baseDirOverride?: string;
}

const EMPTY: ImportedBookmarks = { folders: [], bookmarks: [] };

function resolveBaseDir(options: ChromiumImporterOptions): string | null {
  if (options.baseDirOverride) return options.baseDirOverride;
  const relative =
    process.platform === "darwin"
      ? options.darwinDir
      : process.platform === "linux"
        ? options.linuxDir
        : process.platform === "win32"
          ? options.win32Dir
          : undefined;
  return relative ? path.join(os.homedir(), relative) : null;
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Profile dir names + display names from Local State's info_cache. */
function profilesFromLocalState(
  baseDir: string,
): Array<{ id: string; name: string }> | null {
  const localState = readJson(path.join(baseDir, "Local State"));
  if (!isRecord(localState)) return null;
  const profile = localState.profile;
  if (!isRecord(profile)) return null;
  const infoCache = profile.info_cache;
  if (!isRecord(infoCache)) return null;
  const entries = Object.entries(infoCache);
  if (entries.length === 0) return null;
  return entries.map(([dirName, info]) => {
    const name =
      isRecord(info) && typeof info.name === "string" ? info.name : "";
    return { id: dirName, name: name.trim() || dirName };
  });
}

/** Fallback: any subdirectory holding a Bookmarks file is a profile. */
function profilesFromScan(
  baseDir: string,
): Array<{ id: string; name: string }> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const profiles: Array<{ id: string; name: string }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      if (fs.existsSync(path.join(baseDir, entry.name, "Bookmarks"))) {
        profiles.push({ id: entry.name, name: entry.name });
      }
    } catch {
      // Unreadable entry — skip it.
    }
  }
  return profiles;
}

function isHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

/**
 * Walk one bookmark tree node. Nesting is flattened to a single level: a
 * bookmark's `folder` is the name of its NEAREST ancestor folder, and items
 * directly under a root container (bookmark bar, other, synced) have none —
 * the containers themselves are not folders.
 */
function walkNode(
  node: unknown,
  nearestFolder: string | undefined,
  out: ImportedBookmark[],
): void {
  if (!isRecord(node)) return;
  if (node.type === "url") {
    const url = node.url;
    if (typeof url !== "string" || !isHttpUrl(url)) return;
    const name = typeof node.name === "string" ? node.name.trim() : "";
    out.push({ label: name || url, url, folder: nearestFolder });
    return;
  }
  const children = node.children;
  if (!Array.isArray(children)) return;
  const folderName =
    node.type === "folder" && typeof node.name === "string" && node.name.trim()
      ? node.name.trim()
      : nearestFolder;
  for (const child of children) walkNode(child, folderName, out);
}

function readBookmarksFile(file: string): ImportedBookmarks {
  const parsed = readJson(file);
  if (!isRecord(parsed) || !isRecord(parsed.roots)) return EMPTY;
  const collected: ImportedBookmark[] = [];
  for (const rootKey of ["bookmark_bar", "other", "synced"]) {
    const root = parsed.roots[rootKey];
    if (!isRecord(root) || !Array.isArray(root.children)) continue;
    // Iterate the container's children directly so the container's own name
    // ("Bookmarks Bar", "Other Bookmarks") never becomes a folder label.
    for (const child of root.children) walkNode(child, undefined, collected);
  }
  // Dedupe exact (url, label, folder) triples, preserving first-seen order.
  const seen = new Set<string>();
  const folders: string[] = [];
  const folderSeen = new Set<string>();
  const bookmarks: ImportedBookmark[] = [];
  for (const bookmark of collected) {
    const key = `${bookmark.url}\n${bookmark.label}\n${bookmark.folder ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    bookmarks.push(bookmark);
    if (bookmark.folder && !folderSeen.has(bookmark.folder)) {
      folderSeen.add(bookmark.folder);
      folders.push(bookmark.folder);
    }
  }
  return { folders, bookmarks };
}

export function chromiumImporter(
  options: ChromiumImporterOptions,
): BrowserImporter {
  const readBookmarks = (profileId: string): ImportedBookmarks => {
    const baseDir = resolveBaseDir(options);
    if (!baseDir) return EMPTY;
    // Refuse path-traversal-ish profile ids; they can only come from us.
    if (profileId.includes("/") || profileId.includes("\\")) return EMPTY;
    try {
      return readBookmarksFile(path.join(baseDir, profileId, "Bookmarks"));
    } catch {
      return EMPTY;
    }
  };

  return {
    id: options.id,
    label: options.label,

    detect(): ImportableBrowser | null {
      const baseDir = resolveBaseDir(options);
      if (!baseDir) return null;
      try {
        if (!fs.statSync(baseDir).isDirectory()) return null;
      } catch {
        return null;
      }
      const found =
        profilesFromLocalState(baseDir) ?? profilesFromScan(baseDir);
      const profiles: ImportableProfile[] = found.map(({ id, name }) => ({
        id,
        name,
        bookmarkCount: readBookmarks(id).bookmarks.length,
      }));
      return { id: options.id, label: options.label, profiles };
    },

    readBookmarks,
  };
}
