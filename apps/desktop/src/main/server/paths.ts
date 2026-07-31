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
  };
}
