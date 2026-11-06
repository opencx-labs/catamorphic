import { useEffect, useRef, useState } from "react";
import { DEFAULT_PREFS, normalizePrefs } from "../../shared/app-prefs.js";
import { desktopApi } from "./desktop-api.js";

/**
 * Whether a message sent while the agent works waits for its turn to end
 * (the profile's `chatQueueMessages`) instead of reaching the agent at its
 * next step (ADR 0240), kept live. Read alone, like `useWorkDisplay`: a
 * preference change that leaves it as it is sets nothing, so the chat is
 * not even called again.
 */
export function useQueueMessages(): boolean {
  const [queue, setQueue] = useState(DEFAULT_PREFS.chatQueueMessages);
  const shown = useRef(queue);
  useEffect(() => {
    let cancelled = false;
    const apply = (prefs: unknown) => {
      const next = normalizePrefs(prefs).chatQueueMessages;
      if (cancelled || shown.current === next) return;
      shown.current = next;
      setQueue(next);
    };
    void desktopApi.getPrefs().then(apply);
    const unsubscribe = desktopApi.onPrefsChanged(apply);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);
  return queue;
}
