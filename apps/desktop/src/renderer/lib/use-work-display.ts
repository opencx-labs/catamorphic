import { useEffect, useRef, useState } from "react";
import {
  DEFAULT_WORK_DISPLAY,
  type WorkDisplay,
} from "../components/catamorphic/turn-rows.js";
import { desktopApi } from "./desktop-api.js";

/**
 * The profile's choice for how a turn's work reads, kept live. Every
 * preference change reaches every chat (the dock's fold among them, saved
 * as it starts); one that leaves this choice as it is sets nothing, so the
 * chat is not even called again: React may call a component for an
 * unchanged state before it skips its children, and a chat is a large
 * component to call in the middle of a motion.
 */
export function useWorkDisplay(): WorkDisplay {
  const [display, setDisplay] = useState<WorkDisplay>(DEFAULT_WORK_DISPLAY);
  const shown = useRef(display);
  useEffect(() => {
    let cancelled = false;
    const apply = (prefs: {
      chatWorkLive: WorkDisplay["live"];
      chatWorkSettled: WorkDisplay["settled"];
    }) => {
      if (
        shown.current.live === prefs.chatWorkLive &&
        shown.current.settled === prefs.chatWorkSettled
      )
        return;
      shown.current = {
        live: prefs.chatWorkLive,
        settled: prefs.chatWorkSettled,
      };
      setDisplay(shown.current);
    };
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
