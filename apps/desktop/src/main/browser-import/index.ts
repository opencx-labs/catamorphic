import { chromiumImporter } from "./chromium.js";
import { firefoxImporter } from "./firefox.js";
import type {
  BrowserImporter,
  ImportableBrowser,
  ImportedBookmarks,
} from "./types.js";

export type { ChromiumImporterOptions } from "./chromium.js";
export { chromiumImporter } from "./chromium.js";
export { firefoxImporter } from "./firefox.js";
export type {
  BrowserImporter,
  ImportableBrowser,
  ImportableProfile,
  ImportedBookmark,
  ImportedBookmarks,
} from "./types.js";

/** All browsers we know how to import from, in UI display order. */
export const BROWSER_IMPORTERS: BrowserImporter[] = [
  chromiumImporter({
    id: "chrome",
    label: "Google Chrome",
    darwinDir: "Library/Application Support/Google/Chrome",
    linuxDir: ".config/google-chrome",
    win32Dir: "AppData/Local/Google/Chrome/User Data",
  }),
  chromiumImporter({
    id: "edge",
    label: "Microsoft Edge",
    darwinDir: "Library/Application Support/Microsoft Edge",
    linuxDir: ".config/microsoft-edge",
    win32Dir: "AppData/Local/Microsoft/Edge/User Data",
  }),
  chromiumImporter({
    id: "brave",
    label: "Brave",
    darwinDir: "Library/Application Support/BraveSoftware/Brave-Browser",
    linuxDir: ".config/BraveSoftware/Brave-Browser",
    win32Dir: "AppData/Local/BraveSoftware/Brave-Browser/User Data",
  }),
  chromiumImporter({
    id: "arc",
    label: "Arc",
    darwinDir: "Library/Application Support/Arc/User Data",
  }),
  chromiumImporter({
    id: "chromium",
    label: "Chromium",
    darwinDir: "Library/Application Support/Chromium",
    linuxDir: ".config/chromium",
    win32Dir: "AppData/Local/Chromium/User Data",
  }),
  firefoxImporter(),
];

/**
 * Detect installed browsers and their profiles. Browsers that are not
 * installed (or have zero profiles) are omitted; profiles with zero
 * bookmarks are kept — the UI decides whether to offer them.
 */
export function listImportableBrowsers(): ImportableBrowser[] {
  const browsers: ImportableBrowser[] = [];
  for (const importer of BROWSER_IMPORTERS) {
    const detected = importer.detect();
    if (detected && detected.profiles.length > 0) browsers.push(detected);
  }
  return browsers;
}

/** Read one profile's bookmarks. Throws for an unknown browser id. */
export function readBrowserBookmarks(
  browserId: string,
  profileId: string,
): ImportedBookmarks {
  const importer = BROWSER_IMPORTERS.find((entry) => entry.id === browserId);
  if (!importer) throw new Error(`Unknown browser id: ${browserId}`);
  return importer.readBookmarks(profileId);
}
