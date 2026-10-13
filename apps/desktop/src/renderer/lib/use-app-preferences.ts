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
    const load = (request: number) =>
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
    load(request);
    // Another profile in this window: its preferences.
    const reload = () => load(++revision.current);
    window.addEventListener("catamorphic:profile-refetch", reload);
    return () => {
      active = false;
      unsubscribe();
      window.removeEventListener("catamorphic:profile-refetch", reload);
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

/**
 * One profile choice, kept live, and its setter. A change to any other
 * choice leaves the caller alone: the dock renders every chat, and a
 * re-render for an unrelated preference (its own fold, saved as it starts)
 * would land in the middle of that fold's motion.
 */
export function useAppPreference<K extends keyof AppPrefs>(
  key: K,
): [AppPrefs[K], (value: AppPrefs[K]) => Promise<void>] {
  const [value, setValue] = useState<AppPrefs[K]>(DEFAULT_PREFS[key]);
  const revision = useRef(0);
  useEffect(() => {
    let active = true;
    const unsubscribe = desktopApi.onPrefsChanged((next) => {
      revision.current++;
      setValue(normalizePrefs(next)[key]);
    });
    const load = (request: number) =>
      void desktopApi
        .getPrefs()
        .then((next) => {
          if (active && request === revision.current)
            setValue(normalizePrefs(next)[key]);
        })
        .catch(() => {
          // The default stands until the next change says otherwise.
        });
    load(revision.current);
    // Another profile in this window: its preferences.
    const reload = () => load(++revision.current);
    window.addEventListener("catamorphic:profile-refetch", reload);
    return () => {
      active = false;
      unsubscribe();
      window.removeEventListener("catamorphic:profile-refetch", reload);
    };
  }, [key]);
  const update = async (next: AppPrefs[K]) => {
    const request = ++revision.current;
    setValue(next);
    const patch: Partial<AppPrefs> = {};
    patch[key] = next;
    try {
      const saved = await desktopApi.setPrefs(patch);
      if (request === revision.current) setValue(normalizePrefs(saved)[key]);
    } catch {
      if (request === revision.current) {
        const current = await desktopApi.getPrefs().catch(() => null);
        if (current && request === revision.current)
          setValue(normalizePrefs(current)[key]);
      }
    }
  };
  return [value, update];
}
