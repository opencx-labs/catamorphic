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
  appearance: DEFAULT_APPEARANCE,
  source: "app",
  error: "",
  loading: false,
  ready: false,
  reload: () => {},
});

export function TerminalAppearanceProvider({
  children,
}: {
  children: ReactNode;
}) {
  const appTheme = useTheme();
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
  const appearance = useMemo(() => {
    if (source === "ghostty" && loaded) return loaded;
    const colors = appTheme?.colors;
    return {
      ...DEFAULT_APPEARANCE,
      fontFamily: appTheme?.fonts.mono ?? DEFAULT_APPEARANCE.fontFamily,
      theme: colors
        ? {
            background: colors["bg-inset"],
            foreground: colors.fg,
            cursor: colors.accent,
            selectionBackground: colors.accent,
            selectionForeground: colors["accent-fg"],
          }
        : {},
    };
  }, [source, loaded, appTheme]);
  const ready =
    prefsLoaded && (source === "app" || loaded !== null || error !== "");
  return (
    <TerminalAppearanceContext.Provider
      value={{
        appearance,
        source,
        error: source === "ghostty" ? error : "",
        loading: source === "ghostty" && loading,
        ready,
        reload,
      }}
    >
      {children}
    </TerminalAppearanceContext.Provider>
  );
}

export const useTerminalAppearance = () =>
  useContext(TerminalAppearanceContext);
