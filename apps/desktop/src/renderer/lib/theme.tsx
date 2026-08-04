import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from "react";
import { desktopApi, type ResolvedTheme } from "./desktop-api.js";

/**
 * Applies the resolved theme by writing every color token as an inline CSS
 * variable on <html>, overriding the :root defaults in styles.css (which
 * remain the pre-JS first paint). `color-scheme` follows the resolved
 * appearance so native scrollbars/form controls match.
 */
function applyTheme(theme: ResolvedTheme): void {
  const root = document.documentElement;
  for (const [token, value] of Object.entries(theme.colors)) {
    root.style.setProperty(`--color-${token}`, value);
  }
  root.style.colorScheme = theme.appearance;
  root.dataset.theme = theme.appearance;
}

const ThemeContext = createContext<ResolvedTheme | null>(null);

/** Loads the user theme and follows live changes (settings UI or file). */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<ResolvedTheme | null>(null);
  useEffect(() => {
    let mounted = true;
    const load = () =>
      void desktopApi.getTheme().then((loaded) => {
        if (mounted) setTheme(loaded);
      });
    load();
    const unsubscribe = desktopApi.onThemeChanged(setTheme);
    // In-place profile switches change which theme file backs this window
    // without a main-process broadcast — App signals a refetch instead.
    window.addEventListener("catamorphic:profile-refetch", load);
    return () => {
      mounted = false;
      unsubscribe();
      window.removeEventListener("catamorphic:profile-refetch", load);
    };
  }, []);
  useEffect(() => {
    if (theme) applyTheme(theme);
  }, [theme]);
  return (
    <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>
  );
}

/** The current resolved theme, or null before the first load. */
export function useTheme(): ResolvedTheme | null {
  return useContext(ThemeContext);
}
