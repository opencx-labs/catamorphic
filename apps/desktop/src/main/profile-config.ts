import fs from "node:fs";
import path from "node:path";
import { AgentBindingsStore } from "./agent-bindings-store.js";
import { AgentsStore } from "./agents-store.js";
import { ConnectionsStore } from "./connections-store.js";
import { type Keybindings, KeybindingsStore } from "./keybindings.js";
import { type AppPrefs, PrefsStore } from "./prefs.js";
import type { ProfilesStore } from "./profiles.js";
import { RemoteProjectsStore } from "./remote-projects-store.js";
import type { DataPaths } from "./server/paths.js";
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
  private readonly stores = new Map<string, ProfileStores>();
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
  private readonly projectSidebarWatchers = new Map<string, () => void>();
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
  ) {}

  forProfile(profileId: string): ProfileStores {
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
    stores.connections.onChanged(() => {
      for (const listener of this.connectionsListeners) listener(profileId);
    });
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

  /**
   * Store for this user's project-local sidebar override
   * (`profiles/<id>/sidebar-projects/<projectId>.js`, layer 1). Used by the
   * chat agent's `sidebar.local.js` mirror; the file is optional and is
   * never seeded with the template.
   */
  projectSidebarStore(projectId: string): SidebarConfigStore {
    const profileId = this.profiles.profileForProject(projectId).id;
    return new SidebarConfigStore(
      projectLocalSidebarFile(this.profileDir(profileId), projectId),
    );
  }

  /** Idempotent per (profile, project); disposed with everything else. */
  private watchProjectSidebarLayers(
    profileId: string,
    projectId: string,
    projectRoot: string | null,
  ): void {
    const key = `${profileId}\0${projectId}`;
    if (this.projectSidebarWatchers.has(key)) return;
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
    this.projectSidebarWatchers.set(key, () => {
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

  dispose(): void {
    for (const stores of this.stores.values()) {
      stores.theme.dispose();
      stores.keybindings.dispose();
      stores.sidebar.dispose();
      stores.prefs.dispose();
    }
    this.stores.clear();
    for (const dispose of this.projectSidebarWatchers.values()) dispose();
    this.projectSidebarWatchers.clear();
  }
}
