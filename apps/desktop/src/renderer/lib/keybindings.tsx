import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from "react";
import { desktopApi } from "./desktop-api.js";

export type KeybindingAction =
  | "new-tab"
  | "command-palette"
  | "new-floating-chat"
  | "new-browser-tab"
  | "toggle-sidebar"
  | "close-tab";

export type Keybindings = Record<KeybindingAction, string>;

/**
 * Mirrors main/keybindings.ts. These are only the pre-load fallback: the
 * real values arrive from keybindings.json via KeybindingsProvider, and
 * every hint derives from that, so a rebind updates the buttons too.
 */
export const DEFAULT_KEYBINDINGS: Keybindings = {
  "new-tab": "Cmd+T",
  "command-palette": "Cmd+P",
  "new-floating-chat": "Cmd+N",
  "new-browser-tab": "Cmd+Shift+T",
  "toggle-sidebar": "Cmd+B",
  "close-tab": "Cmd+W",
};

const KeybindingsContext = createContext<Keybindings>(DEFAULT_KEYBINDINGS);

/** Loads user keybindings and follows live changes (settings UI or file). */
export function KeybindingsProvider({ children }: { children: ReactNode }) {
  const [bindings, setBindings] = useState<Keybindings>(DEFAULT_KEYBINDINGS);
  useEffect(() => {
    void desktopApi
      .getKeybindings()
      .then((loaded) =>
        setBindings({ ...DEFAULT_KEYBINDINGS, ...loaded } as Keybindings),
      );
    return desktopApi.onKeybindingsChanged((changed) =>
      setBindings({ ...DEFAULT_KEYBINDINGS, ...changed } as Keybindings),
    );
  }, []);
  return (
    <KeybindingsContext.Provider value={bindings}>
      {children}
    </KeybindingsContext.Provider>
  );
}

export function useKeybindings(): Keybindings {
  return useContext(KeybindingsContext);
}

/** True when the event matches a "Cmd+Shift+K"-style binding. */
export function matchesBinding(event: KeyboardEvent, binding: string): boolean {
  const parts = binding.split("+");
  const key = parts.at(-1) ?? "";
  const mods = new Set(parts.slice(0, -1));
  if (event.metaKey !== mods.has("Cmd")) return false;
  if (event.ctrlKey !== mods.has("Ctrl")) return false;
  if (event.altKey !== mods.has("Alt")) return false;
  if (event.shiftKey !== mods.has("Shift")) return false;
  return event.key.toLowerCase() === key.toLowerCase();
}

const MOD_SYMBOLS: Record<string, string> = {
  Cmd: "⌘",
  Ctrl: "⌃",
  Alt: "⌥",
  Shift: "⇧",
};

/** "Cmd+Shift+T" → "⌘⇧T" for ShortcutHint display. */
export function formatBinding(binding: string): string {
  return binding
    .split("+")
    .map((part) => MOD_SYMBOLS[part] ?? part.toUpperCase())
    .join("");
}
