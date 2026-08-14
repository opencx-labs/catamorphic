import type { AppMountProps } from "@catamorphic/ui";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from "react";
import { desktopApi, type ResolvedTheme } from "./desktop-api.js";

type AppHostTheme = NonNullable<AppMountProps["theme"]>;

/**
 * The desktop shell's FEEL, stated once. The app kit ships neutral defaults
 * (ADR 0048: an app's feel is entirely the embedder's); the desktop is just
 * one embedder and passes its own values explicitly. These mirror the
 * primitives in styles.css (`--font-sans`/`--font-mono`/`--radius-*`/
 * `--ease-standard`, 13px body, 28px rows) and DESIGN.md's motion contract
 * (hover feedback 150ms, structural enters 220ms, large surfaces 250ms).
 */
const DESKTOP_FEEL: Omit<AppHostTheme, "appearance" | "colors"> = {
  fonts: {
    sans: '"Inter", system-ui, -apple-system, sans-serif',
    mono: '"JetBrains Mono", ui-monospace, "SF Mono", monospace',
  },
  radii: { sm: "4px", md: "6px", lg: "10px" },
  easing: "cubic-bezier(0.2, 0, 0, 1)",
  baseFontSize: "13px",
  rowHeight: "28px",
  motion: { fast: "150ms", base: "220ms", slow: "250ms" },
};

/**
 * The full theme snapshot a mounted app receives from this shell: the
 * profile's resolved colors plus the desktop's feel tokens. The ONE place
 * the desktop's mount theme is assembled.
 */
export function appHostTheme(theme: ResolvedTheme): AppHostTheme {
  return {
    appearance: theme.appearance,
    colors: theme.colors,
    ...DESKTOP_FEEL,
  };
}

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
