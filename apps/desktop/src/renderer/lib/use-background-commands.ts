import { useMemo, useSyncExternalStore } from "react";
import type { BackgroundCommandView } from "../../shared/background-commands.js";
import { desktopApi } from "./desktop-api.js";

/**
 * Live background commands (ADR 0155), from main: one shared subscription
 * for every chat, so a step keeps pulsing until its process ends.
 */
let commands: BackgroundCommandView[] = [];
const listeners = new Set<() => void>();
let started = false;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!started) {
    started = true;
    const publish = (next: BackgroundCommandView[]) => {
      commands = next;
      for (const notify of listeners) notify();
    };
    desktopApi.onBackgroundCommands(publish);
    void desktopApi.backgroundCommands().then(publish);
  }
  return () => listeners.delete(listener);
}

export function useBackgroundCommands(
  sessionId: string | undefined,
): BackgroundCommandView[] {
  const all = useSyncExternalStore(subscribe, () => commands);
  return useMemo(
    () =>
      sessionId
        ? all
            .filter((command) => command.sessionId === sessionId)
            .sort((a, b) => a.startedAt - b.startedAt)
        : [],
    [all, sessionId],
  );
}
