import { useSyncExternalStore } from "react";

/**
 * The browser tabs whose page waits on a dialog (ADR 0227), by surface key
 * ("browser:<id>"), so a tab out of sight still shows that it waits. Each
 * tab's browser screen keeps its own entry.
 */
const waiting = new Set<string>();
let snapshot: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

export function setPageDialogWaiting(key: string, on: boolean): void {
  if (waiting.has(key) === on) return;
  if (on) waiting.add(key);
  else waiting.delete(key);
  snapshot = new Set(waiting);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Surface keys of the tabs whose page waits on a dialog. */
export function usePageDialogsWaiting(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, () => snapshot);
}
