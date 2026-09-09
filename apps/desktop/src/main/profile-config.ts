import fs from "node:fs";
import path from "node:path";
import type { AppPrefs } from "../shared/app-prefs.js";
import type { SettingsPatch, SettingsScope } from "../shared/settings.js";
import { AgentBindingsStore } from "./agent-bindings-store.js";
import { AgentsStore } from "./agents-store.js";
import { ConnectionsStore } from "./connections-store.js";
import { type Keybindings, KeybindingsStore } from "./keybindings.js";
import { PrefsStore } from "./prefs.js";
import type { ProfilesStore } from "./profiles.js";
import { RemoteProjectsStore } from "./remote-projects-store.js";
import type { DataPaths } from "./server/paths.js";
import {
  type SettingsFiles,
  SettingsStore,
  saveSettings,
} from "./settings-store.js";
import {
  projectLocalSidebarFile,
  projectSidebarFile,
  type ResolvedSidebarConfig,
  resolveSidebarConfig,
  SidebarConfigStore,
  watchSidebarLayerFile,
} from "./sidebar-config.js";
import {
  type ResolvedTheme,
  type ThemeAppearance,
  ThemeStore,
} from "./theme.js";

/** Everything a profile owns beyond browser state: look, keys, agents. */
export interface ProfileStores {
  theme: ThemeStore;
  keybindings: KeybindingsStore;
  sidebar: SidebarConfigStore;
  agents: AgentsStore;
  /** Consent + auth bindings for PROJECT agents (ADR 0050). */
  agentBindings: AgentBindingsStore;
  prefs: PrefsStore;
  /** Profile-level MCP connections (agents opt in per assignment). */
  connections: ConnectionsStore;
  /** Remote projects: local folders synced from a hosting backend (ADR 0055). */
  remoteProjects: RemoteProjectsStore;
}

/**
 * Profiles own their whole environment: theme, keyboard shortcuts, sidebar
 * layout, and the AI agent roster all live in `profiles/<id>/` next to the
 * profile's browsing state. This manager lazily instantiates the per-profile
 * store set, watches the files (agents and users edit them directly), and
 * fans changes out to subscribers tagged with the profile id — so a window
 * showing profile A never repaints because profile B changed its theme.
 */
export class ProfileConfigManager {
  private readonly unsubscribeRemoved: () => void;
  private readonly unsubscribeConnections = new Map<string, () => void>();
  private readonly stores = new Map<string, ProfileStores>();
  private readonly settingsStores = new Map<string, SettingsStore>();
  private readonly themeListeners = new Set<
    (profileId: string, theme: ResolvedTheme) => void
  >();
  private readonly keybindingsListeners = new Set<
    (profileId: string, bindings: Keybindings) => void
  >();
  // Sidebar changes carry no payload: the resolved config depends on the
  // renderer's active project (layered resolution), so listeners refetch.
  private readonly sidebarListeners = new Set<(profileId: string) => void>();
  /** Lazy per-(profile, project) watchers on the non-profile layers. */
  private readonly projectConfigWatchers = new Map<string, () => void>();
  private readonly connectionsListeners = new Set<
    (profileId: string) => void
  >();
  private readonly prefsListeners = new Set<
    (profileId: string, prefs: AppPrefs) => void
  >();

  constructor(
    private readonly paths: DataPaths,
    private readonly profiles: ProfilesStore,
    private readonly systemAppearance: () => ThemeAppearance = () => "dark",
  ) {
    this.unsubscribeRemoved = profiles.onRemoved((id) =>
      this.releaseProfile(id),
    );
  }

  forProfile(profileId: string): ProfileStores {
    if (!this.profiles.get(profileId))
      throw new Error(`Profile no longer exists: ${profileId}`);
    const existing = this.stores.get(profileId);
    if (existing) return existing;

    const dir = path.join(this.paths.profilesDir, profileId);
    fs.mkdirSync(dir, { recursive: true });
    const stores: ProfileStores = {
      theme: new ThemeStore(
        path.join(dir, "theme.json"),
        this.systemAppearance,
      ),
      keybindings: new KeybindingsStore(path.join(dir, "keybindings.json")),
      sidebar: new SidebarConfigStore(path.join(dir, "sidebar.js")),
      agents: new AgentsStore(path.join(dir, "agents.json")),
      agentBindings: new AgentBindingsStore(
        path.join(dir, "agent-bindings.json"),
      ),
      prefs: new PrefsStore(path.join(dir, "prefs.json")),
      connections: new ConnectionsStore(path.join(dir, "connections.json")),
      remoteProjects: new RemoteProjectsStore(
        path.join(dir, "remote-projects.json"),
      ),
    };
    stores.sidebar.ensureFile();
    stores.theme.watch((theme) => {
      for (const listener of this.themeListeners) listener(profileId, theme);
    });
    stores.keybindings.watch((bindings) => {
      for (const listener of this.keybindingsListeners) {
        listener(profileId, bindings);
      }
    });
    stores.sidebar.watch(() => this.notifySidebarChanged(profileId));
    stores.prefs.watch((prefs) => {
      for (const listener of this.prefsListeners) listener(profileId, prefs);
    });
    this.unsubscribeConnections.set(
      profileId,
      stores.connections.onChanged(() => {
        for (const listener of this.connectionsListeners) listener(profileId);
      }),
    );
    this.stores.set(profileId, stores);
    return stores;
  }

  /** Stores for the profile that owns a project (lazy default adoption). */
  forProject(projectId: string): ProfileStores {
    return this.forProfile(this.profiles.profileForProject(projectId).id);
  }

  forDefaultProfile(): ProfileStores {
    return this.forProfile(this.profiles.defaultProfile().id);
  }

  private profileDir(profileId: string): string {
    return path.join(this.paths.profilesDir, profileId);
  }

  /** The profile's personal skill tier (ADR 0056): `profiles/<id>/skills/`. */
  userSkillsDir(profileId: string): string {
    return path.join(this.profileDir(profileId), "skills");
  }

  /**
   * Layered sidebar resolution (ADR 0043): this user's per-project
   * override, then the project's shared `.catamorphic/sidebar.js`, then
   * the profile-global `sidebar.js`, then the built-in default. Requesting
   * a project's config lazily registers watchers on its layer files so
   * later edits broadcast like profile edits always have.
   */
  resolveSidebar(
    profileId: string,
    project?: { id: string; rootPath: string | null },
  ): ResolvedSidebarConfig {
    this.forProfile(profileId); // Ensure the profile file + watch exist.
    if (project) {
      this.watchProjectSidebarLayers(profileId, project.id, project.rootPath);
    }
    return resolveSidebarConfig({
      profileDir: this.profileDir(profileId),
      projectId: project?.id,
      projectRoot: project?.rootPath,
    });
  }

  settingsFiles(
    profileId: string,
    project?: { id: string; rootPath: string | null },
  ): SettingsFiles {
    const stores = this.forProfile(profileId);
    const files = {
      profile: stores.prefs.file,
      ...(project
        ? {
            personal: path.join(
              this.profileDir(profileId),
              "settings-projects",
              `${project.id}.json`,
            ),
          }
        : {}),
      ...(project?.rootPath
        ? {
            project: path.join(
              project.rootPath,
              ".catamorphic",
              "settings.json",
            ),
          }
        : {}),
    };
    if (project) {
      const prefix = `${profileId}\0settings:${project.id}:`;
      const key = `${prefix}${project.rootPath}`;
      for (const [existing, dispose] of this.projectConfigWatchers) {
        if (existing.startsWith(prefix) && existing !== key) {
          dispose();
          this.projectConfigWatchers.delete(existing);
        }
      }
      if (!this.projectConfigWatchers.has(key)) {
        const notify = () => this.notifyPrefsChanged(profileId);
        const disposers = [files.personal, files.project].flatMap((file) =>
          file ? [watchSidebarLayerFile(file, notify)] : [],
        );
        this.projectConfigWatchers.set(key, () => {
          for (const dispose of disposers) dispose();
        });
      }
    }
    return files;
  }

  resolveSettings(
    profileId: string,
    project?: { id: string; rootPath: string | null },
    scope: SettingsScope = "personal",
  ) {
    let settings = this.settingsStores.get(profileId);
    if (!settings) {
      settings = new SettingsStore();
      this.settingsStores.set(profileId, settings);
    }
    const result = settings.load(this.settingsFiles(profileId, project), scope);
    const stores = this.forProfile(profileId);
    stores.theme.load();
    stores.keybindings.load();
    const sidebar = this.resolveSidebar(profileId, project);
    result.errors.push(
      ...[
        stores.theme.error,
        stores.keybindings.error,
        sidebar.error ? `${sidebar.file}: ${sidebar.error}` : undefined,
      ].filter((error): error is string => Boolean(error)),
    );
    return result;
  }

  saveSettings(
    profileId: string,
    project: { id: string; rootPath: string | null } | undefined,
    scope: SettingsScope,
    patch: SettingsPatch,
  ) {
    saveSettings({
      files: this.settingsFiles(profileId, project),
      scope,
      patch,
    });
    this.notifyPrefsChanged(profileId);
    return this.resolveSettings(profileId, project, scope);
  }

  private notifyPrefsChanged(profileId: string) {
    const prefs = this.forProfile(profileId).prefs.load();
    for (const listener of this.prefsListeners) listener(profileId, prefs);
  }

  /** Idempotent per (profile, project); disposed with everything else. */
  private watchProjectSidebarLayers(
    profileId: string,
    projectId: string,
    projectRoot: string | null,
  ): void {
    const key = `${profileId}\0${projectId}`;
    if (this.projectConfigWatchers.has(key)) return;
    const notify = () => this.notifySidebarChanged(profileId);
    const disposers: Array<() => void> = [
      watchSidebarLayerFile(
        projectLocalSidebarFile(this.profileDir(profileId), projectId),
        notify,
      ),
    ];
    if (projectRoot) {
      disposers.push(
        watchSidebarLayerFile(projectSidebarFile(projectRoot), notify),
      );
    }
    this.projectConfigWatchers.set(key, () => {
      for (const dispose of disposers) dispose();
    });
  }

  private notifySidebarChanged(profileId: string): void {
    for (const listener of this.sidebarListeners) listener(profileId);
  }

  onThemeChanged(
    listener: (profileId: string, theme: ResolvedTheme) => void,
  ): void {
    this.themeListeners.add(listener);
  }

  /** Re-resolve system-following profiles after the OS appearance changes. */
  systemAppearanceChanged(): void {
    for (const [profileId, stores] of this.stores) {
      if (stores.theme.load().selection !== "system") continue;
      const theme = stores.theme.resolved();
      for (const listener of this.themeListeners) listener(profileId, theme);
    }
  }

  onKeybindingsChanged(
    listener: (profileId: string, bindings: Keybindings) => void,
  ): void {
    this.keybindingsListeners.add(listener);
  }

  onSidebarChanged(listener: (profileId: string) => void): void {
    this.sidebarListeners.add(listener);
  }

  onPrefsChanged(listener: (profileId: string, prefs: AppPrefs) => void): void {
    this.prefsListeners.add(listener);
  }

  /** Fires after any mutation of a profile's connections (IPC or the
   * bridge's "Always allow"), so every window of the profile refetches. */
  onConnectionsChanged(listener: (profileId: string) => void): void {
    this.connectionsListeners.add(listener);
  }

  releaseProfile(profileId: string): void {
    const stores = this.stores.get(profileId);
    stores?.theme.dispose();
    stores?.keybindings.dispose();
    stores?.sidebar.dispose();
    stores?.prefs.dispose();
    this.stores.delete(profileId);
    this.settingsStores.delete(profileId);
    this.unsubscribeConnections.get(profileId)?.();
    this.unsubscribeConnections.delete(profileId);
    for (const [key, dispose] of this.projectConfigWatchers) {
      if (!key.startsWith(`${profileId}\0`)) continue;
      dispose();
      this.projectConfigWatchers.delete(key);
    }
  }

  dispose(): void {
    this.unsubscribeRemoved();
    for (const profileId of this.stores.keys()) this.releaseProfile(profileId);
    this.themeListeners.clear();
    this.keybindingsListeners.clear();
    this.sidebarListeners.clear();
    this.connectionsListeners.clear();
    this.prefsListeners.clear();
  }
}
