import fs from "node:fs";
import path from "node:path";

/**
 * Per-profile app preferences, stored as plain JSON at
 * `profiles/<id>/prefs.json` — same philosophy as keybindings.json: user-
 * and agent-editable, file-watched, applies live. Grows one flat key per
 * preference; unknown keys are preserved on save so future versions (or
 * outside tools) can add keys without this build eating them.
 */
export interface AppPrefs {
  /** Soft chime when an agent finishes or asks a question. */
  notificationSounds: boolean;
  /** OS notification for the same events while the app is unfocused. */
  desktopNotifications: boolean;
}

export const DEFAULT_PREFS: AppPrefs = {
  notificationSounds: true,
  desktopNotifications: true,
};

export function normalizePrefs(raw: unknown): AppPrefs {
  const record =
    typeof raw === "object" && raw !== null
      ? (raw as Record<string, unknown>)
      : {};
  return {
    notificationSounds:
      typeof record.notificationSounds === "boolean"
        ? record.notificationSounds
        : DEFAULT_PREFS.notificationSounds,
    desktopNotifications:
      typeof record.desktopNotifications === "boolean"
        ? record.desktopNotifications
        : DEFAULT_PREFS.desktopNotifications,
  };
}

export class PrefsStore {
  private watcher: fs.FSWatcher | undefined;
  private debounce: ReturnType<typeof setTimeout> | undefined;

  constructor(readonly file: string) {}

  load(): AppPrefs {
    try {
      return normalizePrefs(JSON.parse(fs.readFileSync(this.file, "utf-8")));
    } catch {
      return { ...DEFAULT_PREFS };
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
