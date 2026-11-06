import fs from "node:fs";
import path from "node:path";
import { PROJECT_SETTINGS_PATH } from "@catamorphic/workflow/project-layout";
import type { AppPrefs } from "../shared/app-prefs.js";
import type { ProfileConnection } from "../shared/profile-connections.js";
import {
  PROFILE_SYNC_FILES,
  PROFILE_SYNC_KEYS,
  PROFILE_SYNC_PARTS,
  type ProfileSyncPart,
} from "../shared/profile-sync.js";
import {
  type SettingKey,
  type SettingsPatch,
  type SettingsScope,
  validateSettingsLayer,
} from "../shared/settings.js";
import { AgentBindingsStore } from "./agent-bindings-store.js";
import { AgentsStore } from "./agents-store.js";
import { BookmarksStore } from "./bookmarks.js";
import {
  readConfigObject,
  writeConfigFile,
  writeConfigObject,
} from "./config-file.js";
import { ConnectionsStore } from "./connections-store.js";
import { type Keybindings, KeybindingsStore } from "./keybindings.js";
import { PrefsStore } from "./prefs.js";
import type { ProfilesStore } from "./profiles.js";
import { RemoteProjectsStore } from "./remote-projects-store.js";
import { RunnerKeyStore } from "./runner-key-store.js";
import type { DataPaths } from "./server/paths.js";
import {
  type SettingsFiles,
  SettingsStore,
  type SyncedPrefsFile,
  saveSettings,
  validateSettingsFile,
} from "./settings-store.js";
import {
  normalizeTheme,
  normalizeThemeLayer,
  type ResolvedTheme,
  resolveThemeLayers,
  type ThemeAppearance,
  ThemeStore,
  validateThemeConfig,
} from "./theme.js";
import {
  projectLocalWorkspaceFile,
  projectWorkspaceFile,
  type ResolvedWorkspaceConfig,
  resolveWorkspaceConfig,
  WorkspaceConfigStore,
  watchConfigLayerFile,
} from "./workspace-config.js";

/** Everything a profile owns beyond browser state: look, keys, agents. */
export interface ProfileStores {
  theme: ThemeStore;
  keybindings: KeybindingsStore;
  workspace: WorkspaceConfigStore;
  agents: AgentsStore;
  /** Consent + auth bindings for PROJECT agents (ADR 0050). */
  agentBindings: AgentBindingsStore;
  prefs: PrefsStore;
  /** Profile-level MCP connections (agents opt in per assignment). */
  connections: ConnectionsStore;
  /** Remote projects: local folders synced from a hosting backend (ADR 0055). */
  remoteProjects: RemoteProjectsStore;
  /** The key servers seal this machine's operations to (ADR 0207). */
  runnerKey: RunnerKeyStore;
}

/** The stores whose files a profile can share with another (ADR 0272). */
type SyncedStores = Pick<
  ProfileStores,
  "theme" | "keybindings" | "workspace" | "prefs"
>;

/**
 * Profiles own their whole environment: theme, keyboard shortcuts, sidebar
 * layout, and the AI agent roster all live in `profiles/<id>/` next to the
 * profile's browsing state. This manager lazily instantiates the per-profile
 * store set, watches the files (agents and users edit them directly), and
 * fans changes out to subscribers tagged with the profile id — so a window
 * showing profile A never repaints because profile B changed its theme.
 *
 * A profile may sync parts of its settings with another (ADR 0272): its
 * stores for those parts then read and write the owner's files, so an edit
 * from either profile is an edit to both.
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
  // Workspace changes carry no payload: the resolved config depends on the
  // renderer's active project (layered resolution), so listeners refetch.
  private readonly workspaceListeners = new Set<(profileId: string) => void>();
  /** Lazy per-(profile, project) watchers on the non-profile layers. */
  private readonly projectConfigWatchers = new Map<string, () => void>();
  private readonly connectionsListeners = new Set<
    (profileId: string) => void
  >();
  private readonly prefsListeners = new Set<
    (profileId: string, prefs: AppPrefs) => void
  >();

  /** Browser bookmarks: one file for every profile and project. */
  readonly bookmarks: BookmarksStore;

  constructor(
    private readonly paths: DataPaths,
    private readonly profiles: ProfilesStore,
    private readonly systemAppearance: () => ThemeAppearance = () => "dark",
  ) {
    this.bookmarks = new BookmarksStore(paths.bookmarksFile);
    this.unsubscribeRemoved = profiles.onRemoved((id) => {
      // Profiles synced with the removed one keep its settings: the first
      // takes a copy and the rest follow it. Its folder is still on disk.
      const affected = PROFILE_SYNC_PARTS.flatMap((part) =>
        this.detachOwner(id, part),
      );
      this.releaseProfile(id);
      this.refreshSynced(affected);
    });
  }

  bookmarksFile(): string {
    return this.paths.bookmarksFile;
  }

  /**
   * A profile's connections for its preview card. Unlike `forProfile`, it
   * starts no watchers, creates nothing and decrypts nothing, so hovering a
   * profile that is not open leaves no trace.
   */
  connectionPreviews(profileId: string): ProfileConnection[] {
    if (!this.profiles.get(profileId))
      throw new Error(`Profile no longer exists: ${profileId}`);
    return ConnectionsStore.previews(
      path.join(this.paths.profilesDir, profileId, "connections.json"),
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
      ...this.createSyncedStores(profileId),
      agents: new AgentsStore(path.join(dir, "agents.json")),
      agentBindings: new AgentBindingsStore(
        path.join(dir, "agent-bindings.json"),
      ),
      connections: new ConnectionsStore(path.join(dir, "connections.json")),
      remoteProjects: new RemoteProjectsStore(
        path.join(dir, "remote-projects.json"),
      ),
      runnerKey: new RunnerKeyStore(path.join(dir, "runner-key.json")),
    };
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

  /** A profile's own folder, whatever it syncs. */
  profileDir(profileId: string): string {
    return path.join(this.paths.profilesDir, profileId);
  }

  /** The folder that holds a profile's part: its owner's (ADR 0272). */
  private partDir(profileId: string, part: ProfileSyncPart): string {
    return this.profileDir(this.profiles.syncOwner(profileId, part));
  }

  /** Synced preference keys, grouped by the owner prefs.json that holds them. */
  private syncedPrefs(profileId: string): SyncedPrefsFile[] {
    const byOwner = new Map<string, SettingKey[]>();
    for (const part of PROFILE_SYNC_PARTS) {
      const owner = this.profiles.syncOwner(profileId, part);
      const keys = PROFILE_SYNC_KEYS[part];
      if (owner === profileId || !keys.length) continue;
      byOwner.set(owner, [...(byOwner.get(owner) ?? []), ...keys]);
    }
    return [...byOwner].map(([owner, keys]) => ({
      file: path.join(this.profileDir(owner), "prefs.json"),
      keys,
    }));
  }

  private createSyncedStores(profileId: string): SyncedStores {
    const stores: SyncedStores = {
      theme: new ThemeStore(
        path.join(this.partDir(profileId, "appearance"), "theme.json"),
        this.systemAppearance,
      ),
      keybindings: new KeybindingsStore(
        path.join(this.partDir(profileId, "shortcuts"), "keybindings.json"),
      ),
      workspace: new WorkspaceConfigStore(
        path.join(this.partDir(profileId, "workspace"), "workspace.js"),
      ),
      prefs: new PrefsStore(
        path.join(this.profileDir(profileId), "prefs.json"),
        this.syncedPrefs(profileId),
      ),
    };
    stores.workspace.ensureFile();
    stores.theme.watch((theme) => {
      for (const listener of this.themeListeners) listener(profileId, theme);
    });
    stores.keybindings.watch((bindings) => {
      for (const listener of this.keybindingsListeners) {
        listener(profileId, bindings);
      }
    });
    stores.workspace.watch(() => this.notifyWorkspaceChanged(profileId));
    stores.prefs.watch((prefs) => {
      for (const listener of this.prefsListeners) listener(profileId, prefs);
    });
    return stores;
  }

  /** Point loaded profiles at their current owners and repaint their windows. */
  private refreshSynced(profileIds: Iterable<string>): void {
    for (const profileId of new Set(profileIds)) {
      const stores = this.stores.get(profileId);
      if (!stores || !this.profiles.get(profileId)) continue;
      stores.theme.dispose();
      stores.keybindings.dispose();
      stores.workspace.dispose();
      stores.prefs.dispose();
      Object.assign(stores, this.createSyncedStores(profileId));
      this.settingsStores.delete(profileId);
      this.notifyPrefsChanged(profileId);
      const bindings = stores.keybindings.load();
      for (const listener of this.keybindingsListeners)
        listener(profileId, bindings);
      this.notifyWorkspaceChanged(profileId);
    }
  }

  /**
   * Bring parts of another profile's settings into this one. Kept in sync,
   * this profile (and any profile already sharing its files for the part)
   * uses the source's files from now on; otherwise it takes a copy.
   */
  syncSettings(input: {
    profileId: string;
    from: string;
    parts: readonly ProfileSyncPart[];
    keepInSync: boolean;
  }): void {
    if (!this.profiles.get(input.profileId))
      throw new Error(`Profile no longer exists: ${input.profileId}`);
    if (input.from === input.profileId || !this.profiles.get(input.from))
      throw new Error("Choose another profile to import from");
    const affected = new Set<string>();
    for (const part of input.parts) {
      const source = this.profiles.syncOwner(input.from, part);
      const current = this.profiles.syncOwner(input.profileId, part);
      if (source === current) continue;
      if (input.keepInSync) {
        const group =
          current === input.profileId
            ? [input.profileId, ...this.profiles.syncFollowers(current, part)]
            : [input.profileId];
        this.profiles.setSyncOwners(
          group.map((profileId) => ({ profileId, part, owner: source })),
        );
        for (const profileId of group) affected.add(profileId);
      } else {
        this.copyPart({ from: source, to: current, part });
        for (const profileId of [
          current,
          ...this.profiles.syncFollowers(current, part),
        ])
          affected.add(profileId);
      }
    }
    this.refreshSynced(affected);
  }

  /** For each shared part, the names of the other profiles that share it. */
  sharedSettings(
    profileId: string,
  ): Partial<Record<ProfileSyncPart, string[]>> {
    const shared: Partial<Record<ProfileSyncPart, string[]>> = {};
    for (const part of PROFILE_SYNC_PARTS) {
      const owner = this.profiles.syncOwner(profileId, part);
      const partners = this.profiles
        .list()
        .profiles.filter(
          (profile) =>
            profile.id !== profileId &&
            (profile.id === owner ||
              this.profiles.syncOwner(profile.id, part) === owner),
        )
        .map((profile) => profile.name);
      if (partners.length) shared[part] = partners;
    }
    return shared;
  }

  /** Stop sharing parts: this profile keeps the values it shows now. */
  stopSyncing(input: {
    profileId: string;
    parts: readonly ProfileSyncPart[];
  }): void {
    if (!this.profiles.get(input.profileId))
      throw new Error(`Profile no longer exists: ${input.profileId}`);
    const affected = new Set<string>([input.profileId]);
    for (const part of input.parts) {
      const owner = this.profiles.syncOwner(input.profileId, part);
      if (owner === input.profileId) {
        for (const profileId of this.detachOwner(owner, part))
          affected.add(profileId);
        continue;
      }
      this.copyPart({ from: owner, to: input.profileId, part });
      this.profiles.setSyncOwners([
        { profileId: input.profileId, part, owner: undefined },
      ]);
    }
    this.refreshSynced(affected);
  }

  /**
   * The owner leaves its group: the first follower takes a copy of the part
   * and the others follow it, so they stay in sync with each other.
   */
  private detachOwner(ownerId: string, part: ProfileSyncPart): string[] {
    const followers = this.profiles
      .syncFollowers(ownerId, part)
      .filter((profileId) => this.profiles.get(profileId));
    const [heir, ...rest] = followers;
    if (!heir) return [];
    this.copyPart({ from: ownerId, to: heir, part });
    this.profiles.setSyncOwners([
      { profileId: heir, part, owner: undefined },
      ...rest.map((profileId) => ({ profileId, part, owner: heir })),
    ]);
    return followers;
  }

  /** Copy one part's files and preferences into another profile's own folder. */
  private copyPart(input: {
    from: string;
    to: string;
    part: ProfileSyncPart;
  }): void {
    const fromDir = this.profileDir(input.from);
    const toDir = this.profileDir(input.to);
    const keys = PROFILE_SYNC_KEYS[input.part];
    const prefsFile = path.join(toDir, "prefs.json");
    // Runtime state shares prefs.json: never overwrite an unrepaired edit.
    const prefs = keys.length ? readConfigObject(prefsFile) : undefined;
    if (prefs) {
      validateSettingsLayer(prefs, "profile");
      const source = readConfigObject(path.join(fromDir, "prefs.json"));
      for (const key of keys) {
        if (Object.hasOwn(source, key)) prefs[key] = source[key];
        else delete prefs[key];
      }
    }
    for (const name of PROFILE_SYNC_FILES[input.part]) {
      const source = path.join(fromDir, name);
      const target = path.join(toDir, name);
      if (fs.existsSync(source))
        writeConfigFile(target, fs.readFileSync(source, "utf8"));
      else fs.rmSync(target, { force: true });
    }
    if (prefs) writeConfigObject(prefsFile, prefs);
  }

  /** The profile's personal skill tier (ADR 0056): `profiles/<id>/skills/`. */
  userSkillsDir(profileId: string): string {
    return path.join(this.profileDir(profileId), "skills");
  }

  /**
   * Layered workspace resolution (ADR 0043): this user's per-project
   * override, then the project's shared `.work/workspace.js`, then
   * the profile-global `workspace.js`, then the built-in default. Requesting
   * a project's config lazily registers watchers on its layer files so
   * later edits broadcast like profile edits always have.
   */
  resolveWorkspace(
    profileId: string,
    project?: { id: string; rootPath: string | null },
  ): ResolvedWorkspaceConfig {
    this.forProfile(profileId); // Ensure the profile file + watch exist.
    if (project) {
      this.watchProjectWorkspaceLayers(profileId, project.id, project.rootPath);
    }
    return resolveWorkspaceConfig({
      profileDir: this.profileDir(profileId),
      profileFile: this.forProfile(profileId).workspace.file,
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
      ...(stores.prefs.synced.length ? { synced: stores.prefs.synced } : {}),
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
            project: path.join(project.rootPath, PROJECT_SETTINGS_PATH),
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
          file ? [watchConfigLayerFile(file, notify)] : [],
        );
        this.projectConfigWatchers.set(key, () => {
          for (const dispose of disposers) dispose();
        });
      }
    }
    return files;
  }

  private settingsStore(profileId: string): SettingsStore {
    let store = this.settingsStores.get(profileId);
    if (!store) {
      store = new SettingsStore();
      this.settingsStores.set(profileId, store);
    }
    return store;
  }

  themeFile(input: {
    profileId: string;
    projectId?: string;
    projectRoot?: string | null;
    scope?: SettingsScope;
  }): string {
    const scope = input.scope ?? (input.projectId ? "personal" : "profile");
    if (scope === "profile") return this.forProfile(input.profileId).theme.file;
    const files = this.settingsFiles(
      input.profileId,
      input.projectId
        ? { id: input.projectId, rootPath: input.projectRoot ?? null }
        : undefined,
    );
    const file = files[scope];
    if (!file) throw new Error("This theme scope is unavailable");
    return file;
  }

  themeConfig(input: {
    profileId: string;
    projectId?: string;
    projectRoot?: string | null;
    scope?: SettingsScope;
  }) {
    const scope = input.scope ?? (input.projectId ? "personal" : "profile");
    if (scope === "profile")
      return this.forProfile(input.profileId).theme.load();
    return normalizeThemeLayer(
      this.settingsStore(input.profileId).read(this.themeFile(input), scope)
        .value.theme,
    );
  }

  projectTheme(input: {
    profileId: string;
    projectId?: string;
    projectRoot?: string | null;
    scope?: SettingsScope;
  }): ResolvedTheme {
    const profile = this.forProfile(input.profileId).theme.load();
    if (!input.projectId || input.scope === "profile")
      return resolveThemeLayers([profile], this.systemAppearance());
    const files = this.settingsFiles(input.profileId, {
      id: input.projectId,
      rootPath: input.projectRoot ?? null,
    });
    const store = this.settingsStore(input.profileId);
    return resolveThemeLayers(
      [
        profile,
        store.read(files.project, "project").value.theme,
        ...(input.scope === "project"
          ? []
          : [store.read(files.personal, "personal").value.theme]),
      ],
      this.systemAppearance(),
    );
  }

  saveProjectTheme(input: {
    profileId: string;
    projectId?: string;
    projectRoot?: string | null;
    scope?: SettingsScope;
    theme: unknown;
  }) {
    const scope = input.scope ?? (input.projectId ? "personal" : "profile");
    if (input.theme !== null && input.theme !== undefined) {
      if (typeof input.theme !== "object" || Array.isArray(input.theme))
        throw new Error("Theme must be a JSON object");
      validateThemeConfig(Object.fromEntries(Object.entries(input.theme)));
    }
    if (scope === "profile")
      this.forProfile(input.profileId).theme.save(normalizeTheme(input.theme));
    else {
      const file = this.themeFile(input);
      const raw = readConfigObject(file);
      validateSettingsFile(raw, scope);
      if (input.theme === null || input.theme === undefined) delete raw.theme;
      else {
        const extras =
          raw.theme && typeof raw.theme === "object"
            ? Object.fromEntries(
                Object.entries(raw.theme).filter(
                  ([key]) =>
                    !["selection", "preset", "overrides", "fonts"].includes(
                      key,
                    ),
                ),
              )
            : {};
        raw.theme = { ...extras, ...normalizeThemeLayer(input.theme) };
      }
      writeConfigObject(file, raw);
    }
    this.notifyPrefsChanged(input.profileId);
    return this.projectTheme(input);
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
    const workspace = this.resolveWorkspace(profileId, project);
    result.errors.push(
      ...[
        stores.theme.error,
        stores.keybindings.error,
        this.bookmarks.error,
        workspace.error ? `${workspace.file}: ${workspace.error}` : undefined,
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
    for (const listener of this.themeListeners)
      listener(profileId, this.forProfile(profileId).theme.resolved());
  }

  /** Idempotent per (profile, project); disposed with everything else. */
  private watchProjectWorkspaceLayers(
    profileId: string,
    projectId: string,
    projectRoot: string | null,
  ): void {
    const key = `${profileId}\0${projectId}`;
    if (this.projectConfigWatchers.has(key)) return;
    const notify = () => this.notifyWorkspaceChanged(profileId);
    const disposers: Array<() => void> = [
      watchConfigLayerFile(
        projectLocalWorkspaceFile(this.profileDir(profileId), projectId),
        notify,
      ),
    ];
    if (projectRoot) {
      disposers.push(
        watchConfigLayerFile(projectWorkspaceFile(projectRoot), notify),
      );
    }
    this.projectConfigWatchers.set(key, () => {
      for (const dispose of disposers) dispose();
    });
  }

  private notifyWorkspaceChanged(profileId: string): void {
    for (const listener of this.workspaceListeners) listener(profileId);
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

  onWorkspaceChanged(listener: (profileId: string) => void): void {
    this.workspaceListeners.add(listener);
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
    stores?.workspace.dispose();
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
    this.workspaceListeners.clear();
    this.connectionsListeners.clear();
    this.prefsListeners.clear();
  }
}
