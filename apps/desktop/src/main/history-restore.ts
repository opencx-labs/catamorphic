/**
 * A reopened tab (ADR 0188) or a woken one (ADR 0194) goes back in with its
 * history. Restored or not, the tab shows its page.
 */

/** Chromium's net error for a load a newer navigation replaced. */
const ABORTED = -3;

export interface RestoringGuest {
  readonly navigationHistory: Pick<Electron.NavigationHistory, "restore">;
  isDestroyed(): boolean;
  isLoading(): boolean;
  loadURL(url: string): Promise<void>;
}

export async function restoreGuestHistory({
  guest,
  history,
}: {
  guest: RestoringGuest;
  history: { index: number; entries: Electron.NavigationEntry[] };
}): Promise<void> {
  try {
    await guest.navigationHistory.restore(history);
    return;
  } catch (error) {
    // A restore a newer navigation replaced already has a page coming.
    if (errorNumber(error) === ABORTED) return;
  }
  // The rejection can run while Chromium still has a navigation on the
  // stack, where Electron refuses a load with a synthetic ERR_FAILED: the
  // page loads once the stack has unwound, if nothing else is loading.
  await new Promise((resolve) => setImmediate(resolve));
  const page = history.entries[history.index];
  if (!page || guest.isDestroyed() || guest.isLoading()) return;
  await guest.loadURL(page.url).catch(() => {
    // A load that fails shows as the tab's own error page.
  });
}

/** The net error a rejected Electron load carries, if any. */
function errorNumber(error: unknown): number | undefined {
  return typeof error === "object" &&
    error !== null &&
    "errno" in error &&
    typeof error.errno === "number"
    ? error.errno
    : undefined;
}
