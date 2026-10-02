import { flushSync } from "react-dom";
import { prefersReducedMotion } from "./motion.js";

let pending: ViewTransition | undefined;
let toggling: ViewTransition | undefined;

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

type WebviewElement = HTMLElement & {
  executeJavaScript: (code: string) => Promise<unknown>;
};

/**
 * Inside a page: is its main column (the first ancestor of what sits at the
 * middle that spans 40% of the width) centred between real margins? A page
 * cannot be asked where it lands at the new size during the transition (its
 * new size reaches it only once rendering resumes), so its layout is read
 * from symmetry: a centred column moves by half the change, anything else
 * (fluid, full width, left aligned) keeps its left edge.
 */
const GUEST_CENTRED = `(() => {
  let el = document.elementFromPoint(innerWidth / 2, innerHeight * 0.4);
  while (el && el.parentElement && el.getBoundingClientRect().width < innerWidth * 0.4) el = el.parentElement;
  if (!el) return false;
  const rect = el.getBoundingClientRect();
  const right = innerWidth - rect.right;
  return rect.left > innerWidth * 0.05 && Math.abs(rect.left - right) < innerWidth * 0.02;
})()`;

function visibleWebview(content: HTMLElement): WebviewElement | undefined {
  let best: WebviewElement | undefined;
  let area = 0;
  for (const view of content.querySelectorAll<WebviewElement>("webview")) {
    const rect = view.getBoundingClientRect();
    if (rect.width * rect.height > area && view.checkVisibility()) {
      best = view;
      area = rect.width * rect.height;
    }
  }
  return best;
}

/**
 * How far the content's main column moves within its box when the box's
 * width changes by `change`. Content in our own document is laid out at
 * once, so it is measured; a page is read before the toggle.
 */
async function anchorShift(
  content: HTMLElement,
): Promise<(change: number) => number> {
  const centred = (change: number) => change / 2;
  const view = visibleWebview(content);
  if (view) {
    const isCentred = await view
      .executeJavaScript(GUEST_CENTRED)
      .catch(() => true);
    // The page sits at the box's left: a page is resized, not moved.
    return isCentred === false ? () => 0 : centred;
  }
  const rect = content.getBoundingClientRect();
  let element = document.elementFromPoint(
    rect.left + rect.width / 2,
    rect.top + rect.height * 0.4,
  );
  if (!element || !content.contains(element)) return centred;
  while (
    element.parentElement &&
    element !== content &&
    element.getBoundingClientRect().width < rect.width * 0.4
  )
    element = element.parentElement;
  const anchor = element;
  const before = anchor.getBoundingClientRect().left - rect.left;
  return (change) =>
    anchor.isConnected
      ? anchor.getBoundingClientRect().left -
        content.getBoundingClientRect().left -
        before
      : centred(change);
}

/**
 * The content beside a still sidebar takes or gives back its space, as
 * Safari animates its sidebar: the content (a web page in its own process,
 * a terminal, the editor) lays out at its new size once, hidden behind
 * snapshots, whose old and new images travel so its main column moves
 * straight from where it was to where it lands, and cross-fade. Snapshots
 * are GPU textures, so nothing re-lays out or waits on another process
 * while anything moves (ADR 0197). Only the visible workspace animates.
 */
export function transitionSidebarToggle({
  sidebar,
  update,
}: {
  sidebar: Element | null;
  update: () => void;
}) {
  const content = sidebar?.parentElement?.querySelector<HTMLElement>(
    ":scope > .workspace-surface",
  );
  const hidden =
    sidebar
      ?.closest("[data-workspace-visible]")
      ?.getAttribute("data-workspace-visible") === "false";
  if (!animate() || !content || hidden) {
    update();
    return;
  }
  pending?.skipTransition();
  toggling?.skipTransition();
  const root = document.documentElement;
  const widthBefore = content.getBoundingClientRect().width;
  void anchorShift(content).then((shift) => {
    // Named for this transition only; config reloads leave the content be.
    content.style.viewTransitionName = "workspace-content";
    const transition = document.startViewTransition(() => {
      flushSync(update);
      const change = content.getBoundingClientRect().width - widthBefore;
      root.style.setProperty(
        "--content-shift",
        `${Math.round(shift(change))}px`,
      );
    });
    toggling = transition;
    void transition.ready.catch(() => {
      /* A skipped transition still applied its update. */
    });
    void transition.finished.finally(() => {
      content.style.viewTransitionName = "";
      if (toggling !== transition) return;
      toggling = undefined;
      root.style.removeProperty("--content-shift");
    });
  });
}
