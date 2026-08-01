import path from "node:path";
import { app } from "electron";

export interface DataPaths {
  root: string;
  /** PGlite data directory. */
  db: string;
  /** FsBackend working copies. */
  projects: string;
  /** FsRemoteBackend bare repos. */
  remotes: string;
  /** FsBundleStore app bundles. */
  appBundles: string;
  /** settings.json lives directly under userData. */
  settingsFile: string;
  /** GitHub connection (safeStorage-encrypted), beside settings.json. */
  githubFile: string;
  /** User keyboard shortcuts (plain JSON, agent-editable). */
  keybindingsFile: string;
  /** Chrome-style profiles (plain JSON). */
  profilesFile: string;
  /** User-defined sidebar layout (plain JS, agent-editable). */
  sidebarFile: string;
  /** Color theme (plain JSON, agent-editable). */
  themeFile: string;
}

export function resolveDataPaths(): DataPaths {
  const userData = app.getPath("userData");
  const root = path.join(userData, "data");
  return {
    root,
    db: path.join(root, "db"),
    projects: path.join(root, "projects"),
    remotes: path.join(root, "remotes"),
    appBundles: path.join(root, "app-bundles"),
    settingsFile: path.join(userData, "settings.json"),
    githubFile: path.join(userData, "github.json"),
    keybindingsFile: path.join(userData, "keybindings.json"),
    profilesFile: path.join(userData, "profiles.json"),
    sidebarFile: path.join(userData, "sidebar.js"),
    themeFile: path.join(userData, "theme.json"),
  };
}
