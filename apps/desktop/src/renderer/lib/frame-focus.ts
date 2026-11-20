/**
 * Keeps the keys with a surface that holds them (a dialog, the overlay
 * palette) when a page beneath takes focus after the surface did. A
 * browser tab focused a moment before the surface opened finishes that
 * focus later, in another process: the surface had already focused its
 * own field, and the page's late focus took the keys from it, so the
 * surface looked open while typing went to the page under it.
 *
 * The surface takes focus back from any frame outside it once that
 * frame's focus has finished moving (a timeout after the window's blur or
 * a focusin): focus taken back during the move is overridden by it.
 * Returns the function that stops watching.
 */
export function keepFocusFromFrames({
  surface,
  holdsKeys,
  take,
}: {
  /** The surface's element: a frame inside it is its own to focus. */
  surface: () => HTMLElement | null;
  /** Whether the keys are this surface's now (open, topmost). */
  holdsKeys: () => boolean;
  /** Puts focus back where the surface keeps it. */
  take: () => void;
}): () => void {
  let reclaim: ReturnType<typeof setTimeout> | undefined;
  const reclaimFromFrame = () => {
    clearTimeout(reclaim);
    reclaim = setTimeout(() => {
      const element = surface();
      const active = document.activeElement;
      if (
        element &&
        active &&
        (active.tagName === "IFRAME" || active.tagName === "WEBVIEW") &&
        !element.contains(active) &&
        holdsKeys()
      )
        take();
    });
  };
  window.addEventListener("blur", reclaimFromFrame);
  document.addEventListener("focusin", reclaimFromFrame);
  return () => {
    clearTimeout(reclaim);
    window.removeEventListener("blur", reclaimFromFrame);
    document.removeEventListener("focusin", reclaimFromFrame);
  };
}
