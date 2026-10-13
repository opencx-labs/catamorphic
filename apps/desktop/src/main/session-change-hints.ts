import type { WorkWakeups } from "@catamorphic/core";

/** How long a hint waits for more changes before it goes out. */
const QUIET_MS = 250;
/** The longest a burst of changes (a busy turn's steps) holds a hint back. */
const MAX_WAIT_MS = 1_500;

/**
 * Tells the app's windows when its chats may have changed, so their chat
 * lists, attention and watchers read again then rather than on a short
 * poll (ADR 0228): whenever this process logs a change chat lists show
 * (not streamed text), and whenever it serves a request that changes a
 * project (`hint`). A burst of changes goes out as one hint: after
 * `quietMs` without another, or `maxWaitMs` after the first.
 */
export function startSessionChangeHints(input: {
  wakeups: Pick<WorkWakeups, "subscribe">;
  send: () => void;
  quietMs?: number;
  maxWaitMs?: number;
}): { hint: () => void; dispose: () => void } {
  const quietMs = input.quietMs ?? QUIET_MS;
  const maxWaitMs = input.maxWaitMs ?? MAX_WAIT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let firstAt: number | undefined;
  const flush = () => {
    timer = undefined;
    firstAt = undefined;
    input.send();
  };
  const hint = () => {
    const now = Date.now();
    firstAt ??= now;
    clearTimeout(timer);
    timer = setTimeout(
      flush,
      Math.max(0, Math.min(quietMs, firstAt + maxWaitMs - now)),
    );
  };
  const unsubscribe = input.wakeups.subscribe("chats", hint);
  return {
    hint,
    dispose: () => {
      unsubscribe();
      clearTimeout(timer);
      timer = undefined;
      firstAt = undefined;
    },
  };
}
