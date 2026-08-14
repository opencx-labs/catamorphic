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
  /** Legacy pre-profile settings.json (seeds the default profile's agents). */
  settingsFile: string;
  /** GitHub connection (safeStorage-encrypted), beside settings.json. */
  githubFile: string;
  /** Legacy pre-profile keybindings.json (migrated into the default profile). */
  keybindingsFile: string;
  /** Chrome-style profiles (plain JSON). */
  profilesFile: string;
  /** Legacy pre-profile sidebar.js (migrated into the default profile). */
  sidebarFile: string;
  /** Legacy pre-profile theme.json (migrated into the default profile). */
  themeFile: string;
  /**
   * Per-profile home: `profiles/<id>/` holds that profile's theme.json,
   * keybindings.json, sidebar.js, agents.json — plus the browser state that
   * already lived here (history, vault, extensions).
   */
  profilesDir: string;
  /**
   * Per-agent credential homes: `agent-homes/<agentId>/` becomes
   * CLAUDE_CONFIG_DIR / CODEX_HOME for account-authenticated agents, so two
   * agents on the same harness can sign into different accounts.
   */
  agentHomesDir: string;
  /**
   * Host-tier skills (ADR 0049) materialized as a Claude Code plugin
   * (`.claude-plugin/plugin.json` + `skills/<name>/SKILL.md`), so the
   * claude-code harness discovers them natively. Rewritten at boot.
   */
  hostSkillsDir: string;
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
    profilesDir: path.join(userData, "profiles"),
    agentHomesDir: path.join(userData, "agent-homes"),
    hostSkillsDir: path.join(userData, "host-skills"),
  };
}
