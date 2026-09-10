import { useEffect, useRef, useState } from "react";
import {
  type AppPrefs,
  DEFAULT_PREFS,
  normalizePrefs,
} from "../../shared/app-prefs.js";
import { desktopApi } from "./desktop-api.js";

/** File-backed profile choices. Controls and external edits use the same store. */
export function useAppPreferences() {
  const [prefs, setPrefs] = useState(DEFAULT_PREFS);
  const [error, setError] = useState<string | null>(null);
  const revision = useRef(0);
  useEffect(() => {
    let active = true;
    const request = revision.current;
    const unsubscribe = desktopApi.onPrefsChanged((next) => {
      revision.current++;
      setPrefs(normalizePrefs(next));
      setError(null);
    });
    void desktopApi
      .getPrefs()
      .then((next) => {
        if (active && request === revision.current)
          setPrefs(normalizePrefs(next));
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
  return { prefs, update, error };
}
