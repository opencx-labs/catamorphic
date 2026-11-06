import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { TerminalAppearance } from "../../shared/terminal-appearance.js";
import { desktopApi } from "./desktop-api.js";
import { useTheme } from "./theme.js";

const DEFAULT_APPEARANCE: TerminalAppearance = {
  name: "App theme",
  fontFamily: '"JetBrains Mono", ui-monospace, "SF Mono", monospace',
  fontSize: 13,
  theme: {},
};
const TerminalAppearanceContext = createContext({
  loaded: null as TerminalAppearance | null,
  source: "app" as "app" | "ghostty",
  error: "",
  loading: false,
  prefsLoaded: false,
  reload: () => {},
});

export function TerminalAppearanceProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [source, setSource] = useState<"app" | "ghostty">("app");
  const [prefsLoaded, setPrefsLoaded] = useState(false);
  const [loaded, setLoaded] = useState<TerminalAppearance | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    let mounted = true;
    const load = () => {
      void desktopApi.getPrefs().then((prefs) => {
        if (mounted) {
          setSource(prefs.terminalAppearance);
          setPrefsLoaded(true);
        }
      });
    };
    load();
    const stop = desktopApi.onPrefsChanged((prefs) =>
      setSource(prefs.terminalAppearance),
    );
    window.addEventListener("catamorphic:profile-refetch", load);
    return () => {
      mounted = false;
      stop();
      window.removeEventListener("catamorphic:profile-refetch", load);
    };
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision explicitly reloads the external Ghostty configuration.
  useEffect(() => {
    if (source !== "ghostty") return;
    let cancelled = false;
    setLoading(true);
    setError("");
    void desktopApi.terminalGhosttyAppearance().then(
      (result) => {
        if (cancelled) return;
        if (result.ok) setLoaded(result.appearance);
        else setError(result.error);
        setLoading(false);
      },
      () => {
        if (cancelled) return;
        setError("Could not read Ghostty's appearance.");
        setLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [source, revision]);
  return (
    <TerminalAppearanceContext.Provider
      value={{
        loaded,
        source,
        error: source === "ghostty" ? error : "",
        loading: source === "ghostty" && loading,
        prefsLoaded,
        reload,
      }}
    >
      {children}
    </TerminalAppearanceContext.Provider>
  );
}

/** App colors belong to the consumer's theme scope, never the profile loader. */
export function useTerminalAppearance() {
  const { loaded, source, error, loading, prefsLoaded, reload } = useContext(
    TerminalAppearanceContext,
  );
  const theme = useTheme();
  const appearance = useMemo<TerminalAppearance>(() => {
    if (source === "ghostty" && loaded) return loaded;
    return {
      ...DEFAULT_APPEARANCE,
      fontFamily: theme?.fonts.mono ?? DEFAULT_APPEARANCE.fontFamily,
      theme: theme
        ? {
            background: theme.colors["bg-inset"],
            foreground: theme.colors.fg,
            cursor: theme.colors.accent,
            selectionBackground: theme.colors.accent,
            selectionForeground: theme.colors["accent-fg"],
          }
        : {},
    };
  }, [source, loaded, theme]);
  return {
    appearance,
    source,
    error,
    loading,
    ready:
      prefsLoaded &&
      (source === "ghostty" && loaded !== null
        ? true
        : theme !== null && (source === "app" || error !== "")),
    reload,
  };
}
