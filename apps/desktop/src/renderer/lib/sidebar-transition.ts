import { flushSync } from "react-dom";

let pending: ViewTransition | undefined;
/** Atomic config replacement without remounting persistent widget instances. */
export function transitionSidebarUpdate(update: () => void) {
  if (
    !document.startViewTransition ||
    document.hidden ||
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  ) {
    update();
    return;
  }
  pending?.skipTransition();
  pending = document.startViewTransition(() => flushSync(update));
  void pending.ready.catch(() => {
    /* Interrupted snapshots still apply their update. */
  });
}
