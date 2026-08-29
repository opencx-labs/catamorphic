/**
 * Neutral shapes for importing profiles + bookmarks from other browsers.
 * Pure data layer: no Electron, no app-store types — the IPC/UI layer maps
 * these onto the app's own `Profile` / `ProjectBookmarks` shapes.
 */

/** A browser installation detected on this machine. */
export interface ImportableBrowser {
  id: string; // "chrome" | "edge" | "brave" | "arc" | "chromium" | "firefox"
  label: string; // "Google Chrome"
  profiles: ImportableProfile[];
}

/** One profile inside a detected browser. */
export interface ImportableProfile {
  id: string; // profile directory name, e.g. "Default", "Profile 1"
  name: string; // human name from the browser's Local State, e.g. "Work"
  bookmarkCount: number; // total bookmarks found (0 if none)
}

/** A bookmark read from another browser, folder path flattened to one level. */
export interface ImportedBookmark {
  label: string;
  url: string;
  folder?: string;
}

export interface ImportedBookmarks {
  folders: string[]; // unique folder labels, in first-seen order
  bookmarks: ImportedBookmark[];
}

export interface BrowserImporter {
  readonly id: string;
  readonly label: string;
  /** Detect installation + enumerate profiles; returns null when not installed. */
  detect(): ImportableBrowser | null;
  readBookmarks(profileId: string): ImportedBookmarks;
}
