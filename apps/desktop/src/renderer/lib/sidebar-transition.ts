import { flushSync } from "react-dom";
import { prefersReducedMotion } from "./motion.js";

let pending: ViewTransition | undefined;
let settling: { transition: ViewTransition; cleanup: () => void } | undefined;

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

/** Chat tabs over the content: each is the content where it shows. */
const CHAT_TABS = "[data-dock-host]:not([data-dock-native]) [data-chat-tab]";

/**
 * The content beside a still sidebar takes or gives back its space with a
 * cross-fade in place: the content (a web page in its own process, a
 * terminal, the editor) lays out at its new size once, behind snapshots;
 * the old one stays exactly where the content was and fades out as the new
 * one fades in. Nothing in the content slides or stretches, and the
 * snapshots are GPU textures, so nothing waits on another process while
 * they fade (ADR 0200, amended 2026-10-09: the box growing into place
 * showed the app's background around it, which read as a glitch). A chat
 * tab over the content fades the same way, from its own place; floating
 * chats and the bubble strip glide (styles.css).
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
  pending?.skipTransition();
  if (settling) {
    settling.transition.skipTransition();
    settling.cleanup();
  }
  const root = document.documentElement;
  // Named for this transition only; config reloads leave them be.
  const layers = [
    { name: "workspace-content", element: content },
    ...[...document.querySelectorAll<HTMLElement>(CHAT_TABS)].map(
      (element, index) => ({ name: `chat-tab-${index}`, element }),
    ),
  ];
  for (const { name, element } of layers) {
    element.style.viewTransitionName = name;
    if (element !== content)
      element.style.setProperty("view-transition-class", "dock-tab");
  }
  // Floating chats and the bubble strip take layers of their own meanwhile.
  root.dataset.contentSettling = "";
  const placement = document.createElement("style");
  const cleanup = () => {
    for (const { element } of layers) {
      element.style.viewTransitionName = "";
      element.style.removeProperty("view-transition-class");
    }
    placement.remove();
    delete root.dataset.contentSettling;
  };
  const transition = document.startViewTransition(() => {
    // Measured as the snapshots caught it: a skipped settle's update has
    // run by now.
    const before = layers.map(({ element }) => element.getBoundingClientRect());
    flushSync(update);
    // Each old snapshot stays where its layer was.
    placement.textContent = layers
      .map(({ name, element }, index) => {
        const was = before[index];
        const now = element.getBoundingClientRect();
        if (!was) return "";
        return `::view-transition-old(${name}) { translate: ${Math.round(was.left - now.left)}px ${Math.round(was.top - now.top)}px; }`;
      })
      .join("\n");
    document.head.append(placement);
  });
  settling = { transition, cleanup };
  void transition.ready.catch(() => {
    /* A skipped transition still applied its update. */
  });
  void transition.finished.finally(() => {
    if (settling?.transition !== transition) return;
    settling = undefined;
    cleanup();
  });
}
