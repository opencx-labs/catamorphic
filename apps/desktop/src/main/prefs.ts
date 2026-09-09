import fs from "node:fs";
import path from "node:path";
import { type AppPrefs, normalizePrefs } from "../shared/app-prefs.js";
import { validateSettingsLayer } from "../shared/settings.js";
import { ConfigFile, readConfigObject } from "./config-file.js";

export class PrefsStore {
  private watcher: fs.FSWatcher | undefined;
  private debounce: ReturnType<typeof setTimeout> | undefined;

  private readonly config: ConfigFile;
  constructor(readonly file: string) {
    this.config = new ConfigFile(file, (raw) =>
      validateSettingsLayer(raw, "profile"),
    );
  }
  get error() {
    return this.config.error;
  }
  read(): Record<string, unknown> {
    return this.config.read();
  }
  load(): AppPrefs {
    return normalizePrefs(this.read());
  }

  save(prefs: Partial<AppPrefs>): AppPrefs {
    const raw = readConfigObject(this.file);
    const next = normalizePrefs({ ...raw, ...prefs });
    // Persist only explicitly supplied choices, never materialize inherited defaults.
    const values = {
      ...raw,
      ...Object.fromEntries(
        Object.keys(prefs)
          .filter((key) => Object.hasOwn(next, key))
          .map((key) => [key, Reflect.get(next, key)]),
      ),
    };
    this.config.write(values);
    return next;
  }

  /** Watch the containing dir (editors replace files by rename). */
  watch(onChange: (prefs: AppPrefs) => void): void {
    this.load();
    const dir = path.dirname(this.file);
    const name = path.basename(this.file);
    this.watcher = fs.watch(dir, (_event, changed) => {
      if (changed !== name) return;
      clearTimeout(this.debounce);
      this.debounce = setTimeout(() => onChange(this.load()), 100);
    });
  }

  dispose(): void {
    this.watcher?.close();
    clearTimeout(this.debounce);
  }
}
