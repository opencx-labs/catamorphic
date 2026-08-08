import fs from "node:fs";
import path from "node:path";
import { AgentsStore } from "./agents-store.js";
import { type Keybindings, KeybindingsStore } from "./keybindings.js";
import { type AppPrefs, PrefsStore } from "./prefs.js";
import type { ProfilesStore } from "./profiles.js";
import type { DataPaths } from "./server/paths.js";
import { SettingsStore } from "./server/settings.js";
import { type SidebarConfig, SidebarConfigStore } from "./sidebar-config.js";
import { type ResolvedTheme, ThemeStore } from "./theme.js";

/** Everything a profile owns beyond browser state: look, keys, agents. */
export interface ProfileStores {
  theme: ThemeStore;
  keybindings: KeybindingsStore;
  sidebar: SidebarConfigStore;
  agents: AgentsStore;
  prefs: PrefsStore;
}

/**
 * Profiles own their whole environment: theme, keyboard shortcuts, sidebar
 * layout, and the AI agent roster all live in `profiles/<id>/` next to the
 * profile's browsing state. This manager lazily instantiates the per-profile
 * store set, watches the files (agents and users edit them directly), and
 * fans changes out to subscribers tagged with the profile id — so a window
 * showing profile A never repaints because profile B changed its theme.
 *
 * First run migrates the legacy single-profile files (`theme.json`,
 * `keybindings.json`, `sidebar.js` at the userData root) into the default
 * profile, and seeds the default profile's agent roster from the legacy
 * `settings.json` model configuration.
 */
export class ProfileConfigManager {
  private readonly stores = new Map<string, ProfileStores>();
  private readonly themeListeners = new Set<
    (profileId: string, theme: ResolvedTheme) => void
  >();
  private readonly keybindingsListeners = new Set<
    (profileId: string, bindings: Keybindings) => void
  >();
  private readonly sidebarListeners = new Set<
    (profileId: string, config: SidebarConfig) => void
  >();
  private readonly prefsListeners = new Set<
    (profileId: string, prefs: AppPrefs) => void
  >();

  constructor(
    private readonly paths: DataPaths,
    private readonly profiles: ProfilesStore,
  ) {}

  /**
   * One-time legacy migration. MUST run after `app.whenReady()` — seeding
   * the agent roster decrypts the legacy settings API key via safeStorage,
   * which throws before app-ready (and SettingsStore swallows that into a
   * null key, silently skipping the seed).
   */
  migrate(): void {
    this.migrateLegacyFiles();
  }

  forProfile(profileId: string): ProfileStores {
    const existing = this.stores.get(profileId);
    if (existing) return existing;

    const dir = path.join(this.paths.profilesDir, profileId);
    fs.mkdirSync(dir, { recursive: true });
    const stores: ProfileStores = {
      theme: new ThemeStore(path.join(dir, "theme.json")),
      keybindings: new KeybindingsStore(path.join(dir, "keybindings.json")),
      sidebar: new SidebarConfigStore(path.join(dir, "sidebar.js")),
      agents: new AgentsStore(path.join(dir, "agents.json")),
      prefs: new PrefsStore(path.join(dir, "prefs.json")),
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
    stores.sidebar.watch((config) => {
      for (const listener of this.sidebarListeners) listener(profileId, config);
    });
    stores.prefs.watch((prefs) => {
      for (const listener of this.prefsListeners) listener(profileId, prefs);
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

  onThemeChanged(
    listener: (profileId: string, theme: ResolvedTheme) => void,
  ): void {
    this.themeListeners.add(listener);
  }

  onKeybindingsChanged(
    listener: (profileId: string, bindings: Keybindings) => void,
  ): void {
    this.keybindingsListeners.add(listener);
  }

  onSidebarChanged(
    listener: (profileId: string, config: SidebarConfig) => void,
  ): void {
    this.sidebarListeners.add(listener);
  }

  onPrefsChanged(listener: (profileId: string, prefs: AppPrefs) => void): void {
    this.prefsListeners.add(listener);
  }

  dispose(): void {
    for (const stores of this.stores.values()) {
      stores.theme.dispose();
      stores.keybindings.dispose();
      stores.sidebar.dispose();
      stores.prefs.dispose();
    }
    this.stores.clear();
  }

  /**
   * Move the pre-profile config files into the default profile. Renames are
   * one-time: once a per-profile file exists, the legacy one is ignored.
   */
  private migrateLegacyFiles(): void {
    const defaultId = this.profiles.defaultProfile().id;
    const dir = path.join(this.paths.profilesDir, defaultId);
    fs.mkdirSync(dir, { recursive: true });

    const moves: Array<[legacy: string, name: string]> = [
      [this.paths.themeFile, "theme.json"],
      [this.paths.keybindingsFile, "keybindings.json"],
      [this.paths.sidebarFile, "sidebar.js"],
    ];
    for (const [legacy, name] of moves) {
      const target = path.join(dir, name);
      try {
        if (fs.existsSync(legacy) && !fs.existsSync(target)) {
          fs.renameSync(legacy, target);
        }
      } catch (cause) {
        console.warn(
          `[desktop] Failed to migrate ${name} into profile:`,
          cause,
        );
      }
    }

    // Legacy model settings become the default profile's first agent (Pi),
    // so an already-configured install keeps a working agent.
    const agentsFile = path.join(dir, "agents.json");
    if (!fs.existsSync(agentsFile) && fs.existsSync(this.paths.settingsFile)) {
      try {
        const legacy = new SettingsStore(this.paths.settingsFile).load();
        if (legacy.apiKey) {
          new AgentsStore(agentsFile).create({
            name: "Built-in",
            harness: "ai-sdk",
            provider: legacy.provider,
            model: legacy.model,
            auth: "api-key",
            apiKey: legacy.apiKey,
          });
        }
      } catch (cause) {
        console.warn("[desktop] Failed to seed agents from settings:", cause);
      }
    }
  }
}
