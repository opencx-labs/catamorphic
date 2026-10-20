import { useEffect, useMemo, useState } from "react";
import type { VoiceReading } from "../../shared/voice.js";
import { desktopApi } from "./desktop-api.js";

/**
 * The reply being read aloud in this window's profile (ADR 0268), if any.
 * It changes only when the reading does, not with every voice status, so
 * a timeline that shows it re-renders only then.
 */
export function useVoiceReading(): VoiceReading | null {
  const [reading, setReading] = useState<VoiceReading | null>(null);
  useEffect(() => {
    let live = true;
    void desktopApi.voiceStatus().then((status) => {
      if (live) setReading(status.reading);
    });
    const unsubscribe = desktopApi.onVoiceStatus((status) =>
      setReading(status.reading),
    );
    return () => {
      live = false;
      unsubscribe();
    };
  }, []);
  const itemId = reading?.itemId ?? null;
  const preparing = reading?.preparing ?? false;
  return useMemo(
    () => (itemId === null ? null : { itemId, preparing }),
    [itemId, preparing],
  );
}
