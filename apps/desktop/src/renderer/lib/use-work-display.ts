import { useEffect, useState } from "react";
import { desktopApi } from "./desktop-api.js";
import { DEFAULT_WORK_DISPLAY, type WorkDisplay } from "./turn-groups.js";

/** The profile's choice for how a turn's work reads, kept live. */
export function useWorkDisplay(): WorkDisplay {
  const [display, setDisplay] = useState<WorkDisplay>(DEFAULT_WORK_DISPLAY);
  useEffect(() => {
    let cancelled = false;
    const apply = (prefs: {
      chatWorkLive: WorkDisplay["live"];
      chatWorkSettled: WorkDisplay["settled"];
    }) =>
      setDisplay((current) =>
        current.live === prefs.chatWorkLive &&
        current.settled === prefs.chatWorkSettled
          ? current
          : { live: prefs.chatWorkLive, settled: prefs.chatWorkSettled },
      );
    void desktopApi.getPrefs().then((prefs) => {
      if (!cancelled) apply(prefs);
    });
    const unsubscribe = desktopApi.onPrefsChanged(apply);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);
  return display;
}
