import type { AppMountProps } from "@catamorphic/ui";
import {
  type CSSProperties,
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  desktopApi,
  type ResolvedTheme,
  type ThemeSurface,
} from "./desktop-api.js";

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

/**
 * A project's theme; `profileId`, where a page moves between profiles
 * (voice's bubble), reads it again in the profile it has moved to.
 */
export function useProjectTheme(projectId?: string, profileId?: string) {
  const [loaded, setLoaded] = useState<{
    projectId?: string;
    profileId?: string;
    theme: ResolvedTheme;
  } | null>(null);
  useEffect(() => {
    let live = true;
    let generation = 0;
    const load = () => {
      const request = ++generation;
      void desktopApi.getTheme(projectId).then((next) => {
        if (live && request === generation)
          setLoaded({ projectId, profileId, theme: next });
      });
    };
    load();
    const stop = desktopApi.onThemeChanged(load);
    return () => {
      live = false;
      stop();
    };
  }, [projectId, profileId]);
  // A scope changing owner is unresolved until that owner's read finishes.
  // In particular, a terminal must never bake the previous scope's palette.
  return loaded?.projectId === projectId && loaded?.profileId === profileId
    ? (loaded?.theme ?? null)
    : null;
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
  profileId,
  children,
}: {
  projectId?: string;
  /** Where the page moves between profiles: the one it reads now. */
  profileId?: string;
  children: ReactNode;
}) {
  const theme = useProjectTheme(projectId, profileId);
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

/** Where the picture stays visible; it fades into the surface away from it. */
const BACKDROP_MASK = {
  top: "linear-gradient(to bottom, black 0%, black 20%, transparent 70%)",
  center: "radial-gradient(ellipse at center, black 25%, transparent 70%)",
  bottom: "linear-gradient(to top, black 0%, black 20%, transparent 70%)",
} as const;

/**
 * The theme's picture behind a surface (ADR 0263), drawn on a canvas at
 * 1/pixelate resolution and scaled up without smoothing, so pixelation costs
 * one small draw per resize. Its parent must isolate a stacking context; the
 * backdrop sits under the parent's content and over its background.
 */
export function ThemeBackdrop({ surface }: { surface: ThemeSurface }) {
  const background = useTheme()?.backgrounds?.[surface];
  const canvas = useRef<HTMLCanvasElement>(null);
  const picture = useRef<HTMLImageElement>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    // A cached picture may load before this runs.
    setLoaded(Boolean(picture.current?.complete));
    const element = canvas.current;
    if (!background || !element) return;
    const image = new Image();
    let observer: ResizeObserver | undefined;
    const draw = () => {
      const { width, height } = element.getBoundingClientRect();
      element.width = Math.max(1, Math.round(width / background.pixelate));
      element.height = Math.max(1, Math.round(height / background.pixelate));
      const context = element.getContext("2d");
      if (!context || !image.naturalWidth) return;
      // Cover the surface, anchored where the picture stays visible.
      const scale = Math.max(
        element.width / image.naturalWidth,
        element.height / image.naturalHeight,
      );
      const drawnWidth = image.naturalWidth * scale;
      const drawnHeight = image.naturalHeight * scale;
      const y =
        background.position === "top"
          ? 0
          : background.position === "center"
            ? (element.height - drawnHeight) / 2
            : element.height - drawnHeight;
      context.drawImage(
        image,
        (element.width - drawnWidth) / 2,
        y,
        drawnWidth,
        drawnHeight,
      );
    };
    image.onload = () => {
      draw();
      setLoaded(true);
      observer = new ResizeObserver(draw);
      observer.observe(element);
    };
    image.src = background.image;
    return () => {
      image.onload = null;
      observer?.disconnect();
    };
  }, [background]);
  if (!background) return null;
  // An <img> keeps animated pictures (GIF, WebP) playing; a canvas holds only
  // the first frame, so it is used only to pixelate.
  if (background.pixelate === 1) {
    return (
      <img
        ref={picture}
        src={background.image}
        alt=""
        className="theme-backdrop"
        onLoad={() => setLoaded(true)}
        style={{
          opacity: loaded ? background.opacity : 0,
          filter: background.blur ? `blur(${background.blur}px)` : undefined,
          objectFit: "cover",
          objectPosition: `center ${background.position}`,
          maskImage: BACKDROP_MASK[background.position],
        }}
      />
    );
  }
  return (
    <canvas
      ref={canvas}
      className="theme-backdrop"
      style={{
        opacity: loaded ? background.opacity : 0,
        filter: background.blur ? `blur(${background.blur}px)` : undefined,
        imageRendering: background.pixelate > 1 ? "pixelated" : undefined,
        maskImage: BACKDROP_MASK[background.position],
      }}
    />
  );
}
