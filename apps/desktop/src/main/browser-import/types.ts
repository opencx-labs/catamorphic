/**
 * Neutral shapes for importing browser profile data.
 * Pure data layer: no Electron, no app-store types — the IPC/UI layer maps
 * these onto the app's own `Profile` / `ProjectBookmarks` shapes.
 */

/** A browser installation detected on this machine. */
export interface ImportableBrowser {
  id: string; // "chrome" | "edge" | "brave" | "arc" | "aside" | "chromium"
  label: string; // "Google Chrome"
  profiles: ImportableProfile[];
}

/** One profile inside a detected browser. */
export interface ImportableProfile {
  id: string; // profile directory name, e.g. "Default", "Profile 1"
  name: string; // human name from the browser's Local State, e.g. "Work"
  bookmarkCount: number; // total bookmarks found (0 if none)
  hasPasswords?: boolean;
  hasHistory?: boolean;
  hasSessions?: boolean;
}

/** A bookmark read from another browser with its full folder ancestry. */
export interface ImportedBookmark {
  label: string;
  url: string;
  folderPath?: string[];
}

export interface ImportedFolder {
  /** Root-to-leaf labels. Paths, rather than source ids, cross browsers. */
  path: string[];
}

export interface ImportedBookmarks {
  folders: ImportedFolder[];
  bookmarks: ImportedBookmark[];
}

export interface BrowserImporter {
  readonly id: string;
  readonly label: string;
  /** Detect installation + enumerate profiles; returns null when not installed. */
  detect(): ImportableBrowser | null;
  readBookmarks(profileId: string): ImportedBookmarks;
  passwordSource?(profileId: string): BrowserPasswordSource | null;
  historyFile?(profileId: string): string | null;
  cookieSource?(profileId: string): BrowserCookieSource | null;
}

export interface BrowserEncryptionKey {
  keychainService: string;
  keychainAccount: string;
}

export interface BrowserPasswordSource extends BrowserEncryptionKey {
  files: string[];
}

export interface ImportedHistoryEntry {
  url: string;
  title: string;
  lastVisitAt: number;
  visitCount: number;
}
export interface BrowserCookieSource {
  file: string;
  format: "chromium" | "firefox";
  keychain?: BrowserEncryptionKey;
}
