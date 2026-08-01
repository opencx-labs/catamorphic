import fs from "node:fs";
import path from "node:path";

/**
 * User-level keyboard shortcuts, stored as plain JSON at
 * `<userData>/keybindings.json` so both the Settings UI and outside agents
 * (or the user in a text editor) can edit them. The file is watched and
 * changes apply live — no restart.
 *
 * Binding format: modifiers `Cmd`, `Ctrl`, `Alt`, `Shift` joined with `+`,
 * ending in a key name ("Cmd+T", "Ctrl+Shift+P", "Alt+Escape").
 */
export type KeybindingAction =
  | "new-chat"
  | "new-floating-chat"
  | "toggle-sidebar"
  | "close-tab";

export type Keybindings = Record<KeybindingAction, string>;

export const DEFAULT_KEYBINDINGS: Keybindings = {
  // Chrome muscle memory: Cmd+T always opens a full tab (a new chat tab).
  "new-chat": "Cmd+T",
  // The floating quick-chat aside: Cmd+N ("new") — free because the app
  // is single-window, so Chrome's new-window meaning can't collide.
  "new-floating-chat": "Cmd+N",
  "toggle-sidebar": "Cmd+B",
  "close-tab": "Cmd+W",
};

export const KEYBINDING_ACTIONS = Object.keys(
  DEFAULT_KEYBINDINGS,
) as KeybindingAction[];

const BINDING_PATTERN = /^((Cmd|Ctrl|Alt|Shift)\+)*[\w]([\w-]*)$/;

export function isValidBinding(value: unknown): value is string {
  return typeof value === "string" && BINDING_PATTERN.test(value);
}

/** Keep known actions with valid bindings; fall back to defaults. */
export function normalizeKeybindings(raw: unknown): Keybindings {
  const record =
    typeof raw === "object" && raw !== null
      ? (raw as Record<string, unknown>)
      : {};
  const result = { ...DEFAULT_KEYBINDINGS };
  for (const action of KEYBINDING_ACTIONS) {
    const value = record[action];
    if (isValidBinding(value)) result[action] = value;
  }
  return result;
}

/** "Cmd+W" → Electron accelerator ("CmdOrCtrl+W"). */
export function toAccelerator(binding: string): string {
  return binding.replace(/^Cmd\+|(\+)Cmd\+/g, "$1CmdOrCtrl+");
}

export class KeybindingsStore {
  private watcher: fs.FSWatcher | undefined;
  private debounce: ReturnType<typeof setTimeout> | undefined;

  constructor(readonly file: string) {}

  load(): Keybindings {
    try {
      return normalizeKeybindings(
        JSON.parse(fs.readFileSync(this.file, "utf-8")),
      );
    } catch {
      return { ...DEFAULT_KEYBINDINGS };
    }
  }

  save(bindings: Keybindings): void {
    fs.writeFileSync(
      this.file,
      `${JSON.stringify(normalizeKeybindings(bindings), null, 2)}\n`,
    );
  }

  /**
   * Watch the containing directory (the file itself may not exist yet, and
   * editors replace files by rename, which drops direct-file watchers).
   */
  watch(onChange: (bindings: Keybindings) => void): void {
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
