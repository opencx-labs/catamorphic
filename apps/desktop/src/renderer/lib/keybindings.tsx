import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from "react";
import {
  DEFAULT_KEYBINDINGS,
  type KeybindingAction,
  type Keybindings,
} from "../../shared/actions.js";
import {
  matchesShortcut,
  type ShortcutEvent,
} from "../../shared/keybindings.js";
import { desktopApi } from "./desktop-api.js";

export { DEFAULT_KEYBINDINGS, type KeybindingAction, type Keybindings };

const KeybindingsContext = createContext<Keybindings>(DEFAULT_KEYBINDINGS);

/** Loads user keybindings and follows live changes (settings UI or file). */
export function KeybindingsProvider({ children }: { children: ReactNode }) {
  const [bindings, setBindings] = useState<Keybindings>(DEFAULT_KEYBINDINGS);
  useEffect(() => {
    const load = () =>
      void desktopApi
        .getKeybindings()
        .then((loaded) =>
          setBindings({ ...DEFAULT_KEYBINDINGS, ...loaded } as Keybindings),
        );
    load();
    const unsubscribe = desktopApi.onKeybindingsChanged((changed) =>
      setBindings({ ...DEFAULT_KEYBINDINGS, ...changed } as Keybindings),
    );
    // In-place profile switches swap this window's keybindings file with no
    // broadcast — App signals a refetch instead.
    window.addEventListener("catamorphic:profile-refetch", load);
    return () => {
      unsubscribe();
      window.removeEventListener("catamorphic:profile-refetch", load);
    };
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
export function matchesBinding(event: ShortcutEvent, binding: string): boolean {
  return matchesShortcut({
    event,
    binding,
    mac: /Mac/.test(navigator.platform),
  });
}

const MOD_SYMBOLS: Record<string, string> = {
  Cmd: "⌘",
  Ctrl: "⌃",
  Alt: "⌥",
  Shift: "⇧",
};

const KEY_SYMBOLS: Record<string, string> = {
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
};

/** "Cmd+Shift+T" → "⌘⇧T" for ShortcutHint display. */
export function formatBinding(binding: string): string {
  return binding
    .split("+")
    .map((part) => MOD_SYMBOLS[part] ?? KEY_SYMBOLS[part] ?? part.toUpperCase())
    .join("");
}
