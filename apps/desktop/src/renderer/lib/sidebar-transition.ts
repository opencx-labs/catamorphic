import { flushSync } from "react-dom";
import { prefersReducedMotion } from "./motion.js";

let pending: ViewTransition | undefined;
let settling: { transition: ViewTransition; content: HTMLElement } | undefined;

function animate(): boolean {
  return (
    typeof document.startViewTransition === "function" &&
    !document.hidden &&
    !prefersReducedMotion()
  );
}

/** Atomic config replacement without remounting persistent widget instances. */
export function transitionSidebarUpdate(update: () => void) {
  if (!animate()) {
    update();
    return;
  }
  pending?.skipTransition();
  pending = document.startViewTransition(() => flushSync(update));
  void pending.ready.catch(() => {
    /* Interrupted snapshots still apply their update. */
  });
}

/**
 * The content beside a still sidebar takes or gives back its space with a
 * cross-fade in place: the content (a web page in its own process, a
 * terminal, the editor) lays out at its new size once, behind snapshots;
 * the old one stays exactly where the content was and fades out as the new
 * one fades in. Nothing on screen slides or stretches, and the snapshots
 * are GPU textures, so nothing waits on another process while they fade
 * (ADR 0200, amended 2026-10-09: the box growing into place showed the
 * app's background around it, which read as a glitch).
 *
 * `update` always runs, animated or not; without a transition when
 * `wanted` no longer holds (the sidebar moved again). Only the visible
 * workspace animates.
 */
export function settleSidebarContent({
  sidebar,
  wanted,
  update,
}: {
  /** The sidebar's aside, a sibling of the content. */
  sidebar: Element | null;
  wanted: () => boolean;
  update: () => void;
}) {
  const content = sidebar?.parentElement?.querySelector<HTMLElement>(
    ":scope > .workspace-surface",
  );
  if (
    !animate() ||
    !content ||
    sidebar?.closest('[data-workspace-visible="false"]') ||
    !wanted()
  ) {
    update();
    return;
  }
  const before = content.getBoundingClientRect();
  pending?.skipTransition();
  if (settling) {
    settling.transition.skipTransition();
    settling.content.style.viewTransitionName = "";
  }
  const root = document.documentElement;
  // Named for this transition only; config reloads leave the content be.
  // The chats over it take layers of their own (styles.css).
  content.style.viewTransitionName = "workspace-content";
  root.dataset.contentSettling = "";
  const transition = document.startViewTransition(() => {
    flushSync(update);
    // The old snapshot stays where the content was (styles.css).
    const after = content.getBoundingClientRect();
    root.style.setProperty(
      "--content-from-x",
      `${Math.round(before.left - after.left)}px`,
    );
    root.style.setProperty(
      "--content-from-y",
      `${Math.round(before.top - after.top)}px`,
    );
  });
  settling = { transition, content };
  void transition.ready.catch(() => {
    /* A skipped transition still applied its update. */
  });
  void transition.finished.finally(() => {
    if (settling?.transition !== transition) return;
    settling = undefined;
    content.style.viewTransitionName = "";
    delete root.dataset.contentSettling;
    root.style.removeProperty("--content-from-x");
    root.style.removeProperty("--content-from-y");
  });
}
