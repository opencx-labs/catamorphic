import type { AppMountProps } from "@catamorphic/ui";
import {
  type CSSProperties,
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
  radii: { sm: "4px", md: "6px", lg: "10px" },
  easing: "cubic-bezier(0.2, 0, 0, 1)",
  baseFontSize: "13px",
  rowHeight: "28px",
  motion: { fast: "150ms", base: "220ms", slow: "250ms" },
};

/**
 * The full theme snapshot a mounted app receives from this shell: the
 * profile's resolved colors and fonts plus the desktop's other feel tokens.
 * The ONE place the desktop's mount theme is assembled.
 */
export function appHostTheme(theme: ResolvedTheme): AppHostTheme {
  return {
    appearance: theme.appearance,
    colors: theme.colors,
    ...DESKTOP_FEEL,
    fonts: theme.fonts,
  };
}

/**
 * Applies the resolved theme by writing every color and font token as an
 * inline CSS variable on <html>, overriding the :root defaults in styles.css (which
 * remain the pre-JS first paint). `color-scheme` follows the resolved
 * appearance so native scrollbars/form controls match.
 */
export function applyTheme(theme: ResolvedTheme): void {
  const root = document.documentElement;
  for (const [token, value] of Object.entries(theme.colors)) {
    root.style.setProperty(`--color-${token}`, value);
  }
  for (const [token, value] of Object.entries(theme.fonts)) {
    root.style.setProperty(`--font-${token}`, value);
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

/** Apply the same resolved tokens to windows, project scopes, and chat bubbles. */
export function themeStyle(theme: ResolvedTheme | null): CSSProperties {
  return theme
    ? {
        ...Object.fromEntries(
          Object.entries(theme.colors).map(([key, value]) => [
            `--color-${key}`,
            value,
          ]),
        ),
        ...Object.fromEntries(
          Object.entries(theme.fonts).map(([key, value]) => [
            `--font-${key}`,
            value,
          ]),
        ),
        colorScheme: theme.appearance,
      }
    : {};
}

export function useProjectTheme(projectId?: string) {
  const [theme, setTheme] = useState<ResolvedTheme | null>(null);
  useEffect(() => {
    let live = true;
    let generation = 0;
    const load = () => {
      const request = ++generation;
      void desktopApi.getTheme(projectId).then((next) => {
        if (live && request === generation) setTheme(next);
      });
    };
    load();
    const stop = desktopApi.onThemeChanged(load);
    return () => {
      live = false;
      stop();
    };
  }, [projectId]);
  return theme;
}

/** Resolved theme boundary shared by workspaces and floating chat surfaces. */
export function ThemeScope({
  theme,
  children,
}: {
  theme: ResolvedTheme | null;
  children: ReactNode;
}) {
  return (
    <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>
  );
}

export function ProjectTheme({
  projectId,
  children,
}: {
  projectId?: string;
  children: ReactNode;
}) {
  const theme = useProjectTheme(projectId);
  return (
    <ThemeScope theme={theme}>
      <div
        className="size-full"
        data-theme={theme?.appearance}
        style={themeStyle(theme)}
      >
        {children}
      </div>
    </ThemeScope>
  );
}
