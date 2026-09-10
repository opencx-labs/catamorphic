import { useEffect, useState } from "react";
import { CODE_THEMES, type CodeTheme } from "../../shared/app-prefs.js";
import { desktopApi } from "./desktop-api.js";

export { CODE_THEMES, type CodeTheme };

export function useCodeTheme() {
  const [theme, setTheme] = useState<CodeTheme>("github");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    let changed = false;
    const unsubscribe = desktopApi.onPrefsChanged((prefs) => {
      changed = true;
      setTheme(prefs.codeTheme ?? "github");
    });
    void desktopApi
      .getPrefs()
      .then((prefs) => {
        if (active && !changed) setTheme(prefs.codeTheme ?? "github");
      })
      .catch(() => {
        if (active) setError("Could not load the code theme.");
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);
  const update = async (codeTheme: CodeTheme) => {
    try {
      const prefs = await desktopApi.setPrefs({ codeTheme });
      setTheme(prefs.codeTheme);
      setError(null);
    } catch {
      setError("Could not save the code theme. Try again.");
    }
  };
  return [theme, update, error] as const;
}
export function resolveCodeTheme(theme: CodeTheme, light: boolean) {
  const pairs = {
    github: ["github-light", "github-dark"],
    catppuccin: ["catppuccin-latte", "catppuccin-mocha"],
    "rose-pine": ["rose-pine-dawn", "rose-pine"],
    one: ["one-light", "one-dark-pro"],
    solarized: ["solarized-light", "solarized-dark"],
    vitesse: ["vitesse-light", "vitesse-dark"],
  } as const;
  return pairs[theme][light ? 0 : 1];
}
