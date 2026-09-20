import { useEffect, useRef, useState } from "react";
import {
  type AppPrefs,
  DEFAULT_PREFS,
  normalizePrefs,
} from "../../shared/app-prefs.js";
import { desktopApi } from "./desktop-api.js";

/**
 * File-backed profile choices. Controls and external edits use the same store.
 * `loaded` turns true once the file has been read: until then `prefs` are the
 * defaults, which a decision (a consent gate, a one-time answer) must not act on.
 */
export function useAppPreferences() {
  const [prefs, setPrefs] = useState(DEFAULT_PREFS);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const revision = useRef(0);
  useEffect(() => {
    let active = true;
    const request = revision.current;
    const unsubscribe = desktopApi.onPrefsChanged((next) => {
      revision.current++;
      setPrefs(normalizePrefs(next));
      setLoaded(true);
      setError(null);
    });
    void desktopApi
      .getPrefs()
      .then((next) => {
        if (!active) return;
        if (request === revision.current) setPrefs(normalizePrefs(next));
        setLoaded(true);
      })
      .catch(() => {
        if (active)
          setError("Could not load preferences. Reopen this view to retry.");
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);
  const update = async (patch: Partial<AppPrefs>) => {
    const request = ++revision.current;
    try {
      const next = await desktopApi.setPrefs(patch);
      if (request === revision.current) {
        setPrefs(normalizePrefs(next));
        setError(null);
      }
    } catch {
      setError("Could not save preferences. Try again.");
    }
  };
  return { prefs, loaded, update, error };
}
