import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  BrowserImporter,
  BrowserPasswordSource,
  ImportableBrowser,
  ImportableProfile,
  ImportedBookmark,
  ImportedBookmarks,
  ImportedFolder,
} from "./types.js";

/**
 * Generic importer for Chromium-family browsers (Chrome, Edge, Brave, Arc,
 * Aside, Chromium). They all share the same on-disk layout:
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
  /** macOS Safe Storage identity, queried only after the user starts import. */
  keychainService?: string;
  keychainAccount?: string;
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
  if (hasProfileData(baseDir)) profiles.push({ id: ".", name: "Default" });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      if (hasProfileData(path.join(baseDir, entry.name))) {
        profiles.push({ id: entry.name, name: entry.name });
      }
    } catch {
      // Unreadable entry — skip it.
    }
  }
  return profiles;
}

function hasProfileData(directory: string): boolean {
  return ["Bookmarks", "Login Data", "Login Data For Account"].some((file) =>
    fs.existsSync(path.join(directory, file)),
  );
}

function profileDirectory(baseDir: string, profileId: string): string | null {
  if (!profileId || profileId === ".." || /[/\\\0]/.test(profileId))
    return null;
  try {
    const base = fs.realpathSync(baseDir);
    const directory = fs.realpathSync(path.join(baseDir, profileId));
    if (directory !== base && path.dirname(directory) !== base) return null;
    return directory;
  } catch {
    return null;
  }
}

function isHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

/**
 * Walk one bookmark tree node while retaining the complete folder path.
 * Root containers (bookmark bar, other, synced) are browser chrome and are
 * deliberately excluded from the imported hierarchy.
 */
function walkNode(
  node: unknown,
  folderPath: string[],
  bookmarks: ImportedBookmark[],
  folders: ImportedFolder[],
): void {
  if (!isRecord(node)) return;
  if (node.type === "url") {
    const url = node.url;
    if (typeof url !== "string" || !isHttpUrl(url)) return;
    const name = typeof node.name === "string" ? node.name.trim() : "";
    bookmarks.push({
      label: name || url,
      url,
      ...(folderPath.length > 0 ? { folderPath } : {}),
    });
    return;
  }
  const children = node.children;
  if (!Array.isArray(children)) return;
  const folderName =
    node.type === "folder" && typeof node.name === "string" && node.name.trim()
      ? node.name.trim()
      : undefined;
  const nextPath = folderName ? [...folderPath, folderName] : folderPath;
  if (folderName) folders.push({ path: nextPath });
  for (const child of children) {
    walkNode(child, nextPath, bookmarks, folders);
  }
}

function readBookmarksFile(file: string): ImportedBookmarks {
  const parsed = readJson(file);
  if (!isRecord(parsed) || !isRecord(parsed.roots)) return EMPTY;
  const collected: ImportedBookmark[] = [];
  const collectedFolders: ImportedFolder[] = [];
  for (const rootKey of ["bookmark_bar", "other", "synced"]) {
    const root = parsed.roots[rootKey];
    if (!isRecord(root) || !Array.isArray(root.children)) continue;
    // Iterate the container's children directly so the container's own name
    // ("Bookmarks Bar", "Other Bookmarks") never becomes a folder label.
    for (const child of root.children) {
      walkNode(child, [], collected, collectedFolders);
    }
  }
  // Dedupe exact (url, label, path) triples, preserving first-seen order.
  const seen = new Set<string>();
  const folders: ImportedFolder[] = [];
  const folderSeen = new Set<string>();
  const bookmarks: ImportedBookmark[] = [];
  for (const bookmark of collected) {
    const key = `${bookmark.url}\n${bookmark.label}\n${JSON.stringify(bookmark.folderPath ?? [])}`;
    if (seen.has(key)) continue;
    seen.add(key);
    bookmarks.push(bookmark);
  }
  for (const folder of collectedFolders) {
    const key = JSON.stringify(folder.path);
    if (folderSeen.has(key)) continue;
    folderSeen.add(key);
    folders.push(folder);
  }
  return { folders, bookmarks };
}

export function chromiumImporter(
  options: ChromiumImporterOptions,
): BrowserImporter {
  const readBookmarks = (profileId: string): ImportedBookmarks => {
    const baseDir = resolveBaseDir(options);
    if (!baseDir) return EMPTY;
    const directory = profileDirectory(baseDir, profileId);
    if (!directory) return EMPTY;
    try {
      return readBookmarksFile(path.join(directory, "Bookmarks"));
    } catch {
      return EMPTY;
    }
  };

  const passwordSource = (profileId: string): BrowserPasswordSource | null => {
    if (!options.keychainService || !options.keychainAccount) return null;
    const baseDir = resolveBaseDir(options);
    const directory = baseDir && profileDirectory(baseDir, profileId);
    if (!directory) return null;
    const files = ["Login Data", "Login Data For Account"]
      .map((name) => path.join(directory, name))
      .filter((file) => {
        try {
          return fs.lstatSync(file).isFile();
        } catch {
          return false;
        }
      });
    return files.length
      ? {
          files,
          keychainService: options.keychainService,
          keychainAccount: options.keychainAccount,
        }
      : null;
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
      // Opera can store its default profile directly under the browser root.
      if (hasProfileData(baseDir) && !found.some(({ id }) => id === ".")) {
        found.unshift({ id: ".", name: "Default" });
      }
      const profiles: ImportableProfile[] = found.map(({ id, name }) => ({
        id,
        name,
        bookmarkCount: readBookmarks(id).bookmarks.length,
        ...(options.keychainService
          ? { hasPasswords: passwordSource(id) !== null }
          : {}),
      }));
      return {
        id: options.id,
        label: options.label,
        profiles,
        ...(options.keychainService ? { supportsPasswordImport: true } : {}),
      };
    },

    readBookmarks,
    passwordSource,
  };
}
