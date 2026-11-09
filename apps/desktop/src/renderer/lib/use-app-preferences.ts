import { useCallback, useEffect, useRef, useState } from "react";
import {
  type AppPrefs,
  DEFAULT_PREFS,
  normalizePrefs,
} from "../../shared/app-prefs.js";
import { desktopApi } from "./desktop-api.js";

/** Both public hooks share the same preference reads, writes and ordering. */
function usePreferenceValue<T>(select: (prefs: AppPrefs) => T) {
  const prefs = useRef(DEFAULT_PREFS);
  const [value, setValue] = useState(() => select(DEFAULT_PREFS));
  const shown = useRef(value);
  const [loaded, setLoaded] = useState(false);
  const hasLoaded = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const shownError = useRef<string | null>(null);
  const showError = useCallback((next: string | null) => {
    if (shownError.current === next) return;
    shownError.current = next;
    setError(next);
  }, []);
  const show = useCallback(
    (next: AppPrefs) => {
      prefs.current = next;
      const selected = select(next);
      if (Object.is(shown.current, selected)) return;
      shown.current = selected;
      setValue(() => selected);
    },
    [select],
  );
  const showRef = useRef(show);
  showRef.current = show;
  const active = useRef(false);
  // A new local intent or profile invalidates all earlier completions.
  // Change hints supersede reads, without superseding a pending write.
  const intent = useRef(0);
  const reads = useRef(0);
  const writes = useRef(Promise.resolve());
  const failure = useRef<{ intent: number; message: string } | null>(null);
  const read = useCallback(
    async (owner: number) => {
      const request = ++reads.current;
      try {
        // Even a hint received after an intent must not read the old file
        // before that save finishes. Overlapping keys share this barrier.
        await writes.current;
        if (!active.current) return prefs.current;
        const next = normalizePrefs(await desktopApi.getPrefs());
        if (
          active.current &&
          owner === intent.current &&
          request === reads.current
        ) {
          showRef.current(next);
          if (!hasLoaded.current) {
            hasLoaded.current = true;
            setLoaded(true);
          }
          showError(
            failure.current?.intent === owner ? failure.current.message : null,
          );
        }
        return next;
      } catch (cause) {
        if (
          active.current &&
          owner === intent.current &&
          request === reads.current
        )
          showError(
            failure.current?.intent === owner
              ? failure.current.message
              : "Could not load preferences. Reopen this view to retry.",
          );
        throw cause;
      }
    },
    [showError],
  );
  const reload = useCallback(() => {
    const owner = ++intent.current;
    failure.current = null;
    showError(null);
    return read(owner);
  }, [read, showError]);
  useEffect(() => {
    active.current = true;
    show(prefs.current);
    // File-watch snapshots can predate the latest local action. Read the
    // canonical store after our pending writes instead of applying them.
    const refresh = () => {
      void read(intent.current).catch(() => {});
    };
    const profileChanged = () => {
      void reload().catch(() => {});
    };
    const unsubscribe = desktopApi.onPrefsChanged(refresh);
    refresh();
    window.addEventListener("catamorphic:profile-refetch", profileChanged);
    return () => {
      active.current = false;
      intent.current++;
      reads.current++;
      unsubscribe();
      window.removeEventListener("catamorphic:profile-refetch", profileChanged);
    };
  }, [read, reload, show]);
  const update = useCallback(
    async (patch: Partial<AppPrefs>) => {
      const owner = ++intent.current;
      failure.current = null;
      showError(null);
      showRef.current(normalizePrefs({ ...prefs.current, ...patch }));
      // Only explicit choices cross IPC. The optimistic rendering defaults
      // must never materialize as overrides in the person's profile.
      const saving = new Promise<AppPrefs>((resolve) => {
        resolve(desktopApi.setPrefs(patch));
      });
      writes.current = Promise.allSettled([writes.current, saving]).then(
        () => {},
      );
      try {
        await saving;
      } catch {
        if (active.current && owner === intent.current) {
          failure.current = {
            intent: owner,
            message: "Could not save preferences. Try again.",
          };
          showError(failure.current.message);
        }
      }
      if (active.current && owner === intent.current)
        await read(owner).catch(() => {});
    },
    [read, showError],
  );
  return { value, loaded, update, reload, error };
}

const profileValues = (prefs: AppPrefs) => prefs;

/**
 * File-backed profile choices. Controls and external edits use the same store.
 * `loaded` turns true once the file has been read: until then `prefs` are the
 * defaults, which a decision (a consent gate, a one-time answer) must not act on.
 */
export function useAppPreferences() {
  const { value: prefs, ...state } = usePreferenceValue(profileValues);
  return { prefs, ...state };
}

/** Choices whose value is a string, number, boolean or null: equal values are the same value. */
type PrimitivePref = {
  [K in keyof AppPrefs]-?: AppPrefs[K] extends
    | string
    | number
    | boolean
    | null
    | undefined
    ? K
    : never;
}[keyof AppPrefs];

/**
 * One profile choice, kept live, its setter, and whether it has been read.
 * Other choices change no state here, so an unrelated save never renders
 * this caller. Until `loaded`, a surface shown at launch must not draw the
 * default as if it were the person's choice.
 */
export function useAppPreference<K extends PrimitivePref>(
  key: K,
): [AppPrefs[K], (value: AppPrefs[K]) => Promise<void>, boolean] {
  const select = useCallback((prefs: AppPrefs) => prefs[key], [key]);
  const { value, loaded, update } = usePreferenceValue(select);
  const change = useCallback(
    (next: AppPrefs[K]) => {
      const patch: Partial<AppPrefs> = {};
      patch[key] = next;
      return update(patch);
    },
    [key, update],
  );
  return [value, change, loaded];
}
