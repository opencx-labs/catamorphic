import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_KEYBINDINGS,
  KEYBINDING_ACTIONS,
  type KeybindingAction,
  type Keybindings,
} from "../shared/actions.js";
import { isValidBinding, parseBinding } from "../shared/keybindings.js";
import { ConfigFile, readConfigObject } from "./config-file.js";

export {
  DEFAULT_KEYBINDINGS,
  KEYBINDING_ACTIONS,
  type KeybindingAction,
  type Keybindings,
};

/**
 * Per-profile keyboard shortcuts, stored as plain JSON at
 * `<userData>/profiles/<id>/keybindings.json` so both the Settings UI and
 * outside agents (or the user in a text editor) can edit them. The file is
 * watched and changes apply live. Actions and their defaults come from the
 * shared registry (shared/actions.ts).
 *
 * Binding format: modifiers `Cmd`, `Ctrl`, `Alt`, `Shift` joined with `+`,
 * ending in a key name ("Cmd+T", "Ctrl+Shift+P", "Alt+Escape").
 */

export { isValidBinding } from "../shared/keybindings.js";

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
export function toAccelerator(binding: string): string | undefined {
  const parsed = parseBinding(binding);
  if (!parsed) return undefined;
  return [
    ...[...parsed.modifiers].map((mod) => (mod === "Cmd" ? "CmdOrCtrl" : mod)),
    parsed.key.replace(/^Arrow/, ""),
  ].join("+");
}

export class KeybindingsStore {
  private watcher: fs.FSWatcher | undefined;
  private debounce: ReturnType<typeof setTimeout> | undefined;

  private readonly config: ConfigFile;
  constructor(readonly file: string) {
    this.config = new ConfigFile(file, (raw) => {
      for (const action of KEYBINDING_ACTIONS) {
        if (Object.hasOwn(raw, action) && !isValidBinding(raw[action]))
          throw new Error(`Invalid shortcut for ${action}`);
      }
      const assigned = new Map<string, string>();
      for (const [action, value] of Object.entries(normalizeKeybindings(raw))) {
        const parsed = parseBinding(value);
        if (!parsed) continue;
        const signature = `${[...parsed.modifiers]
          .map((mod) =>
            mod === "Cmd" && process.platform !== "darwin" ? "Ctrl" : mod,
          )
          .sort()
          .join("+")}:${parsed.key.toLowerCase()}`;
        const other = assigned.get(signature);
        if (other)
          throw new Error(`Shortcut conflict between ${other} and ${action}`);
        assigned.set(signature, action);
      }
    });
  }
  get error() {
    return this.config.error;
  }
  load(): Keybindings {
    return normalizeKeybindings(this.config.read());
  }
  save(bindings: Keybindings): void {
    this.config.write({ ...readConfigObject(this.file), ...bindings });
  }

  /**
   * Watch the containing directory (the file itself may not exist yet, and
   * editors replace files by rename, which drops direct-file watchers).
   */
  watch(onChange: (bindings: Keybindings) => void): void {
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
