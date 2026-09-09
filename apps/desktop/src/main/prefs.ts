import fs from "node:fs";
import path from "node:path";
import { type AppPrefs, normalizePrefs } from "../shared/app-prefs.js";

export class PrefsStore {
  private watcher: fs.FSWatcher | undefined;
  private debounce: ReturnType<typeof setTimeout> | undefined;

  constructor(readonly file: string) {}

  load(): AppPrefs {
    try {
      return normalizePrefs(JSON.parse(fs.readFileSync(this.file, "utf-8")));
    } catch {
      return normalizePrefs({});
    }
  }

  save(prefs: Partial<AppPrefs>): AppPrefs {
    // Preserve unknown keys: read the raw file, overlay known prefs.
    let raw: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf-8"));
      if (typeof parsed === "object" && parsed !== null) {
        raw = parsed as Record<string, unknown>;
      }
    } catch {
      // Missing/corrupt file: start fresh.
    }
    const next = normalizePrefs({ ...raw, ...prefs });
    fs.writeFileSync(
      this.file,
      `${JSON.stringify({ ...raw, ...next }, null, 2)}\n`,
    );
    return next;
  }

  /** Watch the containing dir (editors replace files by rename). */
  watch(onChange: (prefs: AppPrefs) => void): void {
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
