import fs from "node:fs";
import path from "node:path";
import { type AppPrefs, normalizePrefs } from "../shared/app-prefs.js";
import { validateSettingsLayer } from "../shared/settings.js";
import { ConfigFile, readConfigObject } from "./config-file.js";
import {
  composeProfileLayer,
  profilePrefsFile,
  type SyncedPrefsFile,
} from "./settings-store.js";

/**
 * A profile's prefs.json. Preferences it syncs with another profile (ADR
 * 0272) are read from and written to that owner's prefs.json; runtime state
 * and every other key stay in this profile's own file.
 */
export class PrefsStore {
  private readonly watchers: fs.FSWatcher[] = [];
  private debounce: ReturnType<typeof setTimeout> | undefined;

  private readonly configs = new Map<string, ConfigFile>();
  constructor(
    readonly file: string,
    readonly synced: readonly SyncedPrefsFile[] = [],
  ) {
    for (const target of [file, ...synced.map((entry) => entry.file)])
      this.configs.set(
        target,
        new ConfigFile(target, (raw) => validateSettingsLayer(raw, "profile")),
      );
  }
  private config(file: string): ConfigFile {
    const config = this.configs.get(file);
    if (!config) throw new Error(`Not a preferences file: ${file}`);
    return config;
  }
  get error() {
    return [...this.configs.values()].find((config) => config.error)?.error;
  }
  read(): Record<string, unknown> {
    return composeProfileLayer(
      this.config(this.file).read(),
      this.synced.map(({ file, keys }) => ({
        value: this.config(file).read(),
        keys,
      })),
    );
  }
  load(): AppPrefs {
    return normalizePrefs(this.read());
  }

  save(prefs: Partial<AppPrefs>): AppPrefs {
    const next = normalizePrefs({ ...this.read(), ...prefs });
    // Persist only explicitly supplied choices, never materialize inherited defaults.
    const writes = new Map<string, Record<string, unknown>>();
    for (const key of Object.keys(prefs)) {
      if (!Object.hasOwn(next, key)) continue;
      const target = profilePrefsFile(this.file, this.synced, key);
      writes.set(target, {
        ...writes.get(target),
        [key]: Reflect.get(next, key),
      });
    }
    for (const [target, values] of writes)
      this.config(target).write({ ...readConfigObject(target), ...values });
    return next;
  }

  /** Watch each file's dir (editors replace files by rename). */
  watch(onChange: (prefs: AppPrefs) => void): void {
    this.load();
    for (const target of this.configs.keys()) {
      const name = path.basename(target);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      this.watchers.push(
        fs.watch(path.dirname(target), (_event, changed) => {
          if (changed !== name) return;
          clearTimeout(this.debounce);
          this.debounce = setTimeout(() => onChange(this.load()), 100);
        }),
      );
    }
  }

  dispose(): void {
    for (const watcher of this.watchers.splice(0)) watcher.close();
    clearTimeout(this.debounce);
  }
}
