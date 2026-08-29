import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  BrowserImporter,
  ImportableBrowser,
  ImportedBookmark,
  ImportedBookmarks,
} from "./types.js";

export interface FirefoxImporterOptions {
  baseDirOverride?: string;
}

interface FirefoxProfile {
  id: string;
  name: string;
  directory: string;
}

const EMPTY: ImportedBookmarks = { folders: [], bookmarks: [] };

function firefoxBaseDir(options: FirefoxImporterOptions): string | null {
  if (options.baseDirOverride) return options.baseDirOverride;
  const relative =
    process.platform === "darwin"
      ? "Library/Application Support/Firefox"
      : process.platform === "linux"
        ? ".mozilla/firefox"
        : process.platform === "win32"
          ? "AppData/Roaming/Mozilla/Firefox"
          : null;
  return relative ? path.join(os.homedir(), relative) : null;
}

function parseProfiles(baseDir: string): FirefoxProfile[] {
  let source: string;
  try {
    source = fs.readFileSync(path.join(baseDir, "profiles.ini"), "utf-8");
  } catch {
    return [];
  }
  const sections = source.split(/^\s*\[/m).slice(1);
  const profiles: FirefoxProfile[] = [];
  for (const section of sections) {
    const lines = section.split(/\r?\n/);
    const header = lines.shift()?.replace(/\].*$/, "").trim();
    if (!header?.startsWith("Profile")) continue;
    const values = new Map<string, string>();
    for (const line of lines) {
      const separator = line.indexOf("=");
      if (separator < 1) continue;
      values.set(
        line.slice(0, separator).trim(),
        line.slice(separator + 1).trim(),
      );
    }
    const profilePath = values.get("Path");
    if (!profilePath) continue;
    const directory =
      values.get("IsRelative") === "0"
        ? profilePath
        : path.resolve(baseDir, profilePath);
    if (!fs.existsSync(path.join(directory, "places.sqlite"))) continue;
    profiles.push({
      id: profilePath,
      name: values.get("Name")?.trim() || profilePath,
      directory,
    });
  }
  return profiles;
}

function queryBookmarks(file: string): ImportedBookmarks {
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(file, { readOnly: true });
    const rows = database
      .prepare(`
        SELECT b.title AS title, p.url AS url,
               parent.title AS folder, parent.guid AS parent_guid
        FROM moz_bookmarks AS b
        JOIN moz_places AS p ON p.id = b.fk
        LEFT JOIN moz_bookmarks AS parent ON parent.id = b.parent
        WHERE b.type = 1
          AND (p.url LIKE 'http://%' OR p.url LIKE 'https://%')
        ORDER BY b.id
      `)
      .all() as Array<Record<string, unknown>>;
    const rootGuids = new Set([
      "root________",
      "menu________",
      "toolbar_____",
      "unfiled_____",
      "mobile______",
    ]);
    const bookmarks: ImportedBookmark[] = [];
    const folders: string[] = [];
    const folderSeen = new Set<string>();
    const bookmarkSeen = new Set<string>();
    for (const row of rows) {
      if (typeof row.url !== "string") continue;
      const title =
        typeof row.title === "string" && row.title.trim()
          ? row.title.trim()
          : row.url;
      const folder =
        typeof row.folder === "string" &&
        row.folder.trim() &&
        !rootGuids.has(String(row.parent_guid))
          ? row.folder.trim()
          : undefined;
      const key = `${row.url}\n${title}\n${folder ?? ""}`;
      if (bookmarkSeen.has(key)) continue;
      bookmarkSeen.add(key);
      bookmarks.push({
        label: title,
        url: row.url,
        ...(folder ? { folder } : {}),
      });
      if (folder && !folderSeen.has(folder)) {
        folderSeen.add(folder);
        folders.push(folder);
      }
    }
    return { folders, bookmarks };
  } catch {
    return EMPTY;
  } finally {
    database?.close();
  }
}

export function firefoxImporter(
  options: FirefoxImporterOptions = {},
): BrowserImporter {
  const find = (profileId: string): FirefoxProfile | undefined => {
    const baseDir = firefoxBaseDir(options);
    return baseDir
      ? parseProfiles(baseDir).find((profile) => profile.id === profileId)
      : undefined;
  };
  const readBookmarks = (profileId: string): ImportedBookmarks => {
    const profile = find(profileId);
    return profile
      ? queryBookmarks(path.join(profile.directory, "places.sqlite"))
      : EMPTY;
  };
  return {
    id: "firefox",
    label: "Firefox",
    detect(): ImportableBrowser | null {
      const baseDir = firefoxBaseDir(options);
      if (!baseDir) return null;
      const profiles = parseProfiles(baseDir).map((profile) => ({
        id: profile.id,
        name: profile.name,
        bookmarkCount: queryBookmarks(
          path.join(profile.directory, "places.sqlite"),
        ).bookmarks.length,
      }));
      return profiles.length > 0
        ? { id: "firefox", label: "Firefox", profiles }
        : null;
    },
    readBookmarks,
  };
}
