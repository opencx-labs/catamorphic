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

/** How long a page may take to describe its layout before it is assumed centred. */
const PAGE_READ_MS = 100;

type WebviewElement = HTMLElement & {
  executeJavaScript: (code: string) => Promise<unknown>;
};

/**
 * Inside a page: is its main column (the first ancestor of what sits at the
 * middle that spans 40% of the width) centred between real margins? A page
 * cannot report where it lands at its new size during the transition (the
 * size reaches it only once rendering resumes), so its layout is read before
 * the content resizes, from symmetry: a centred column moves by half the
 * change, anything else (fluid, full width, left aligned) keeps its left
 * edge.
 */
const PAGE_CENTRED = `(() => {
  let el = document.elementFromPoint(innerWidth / 2, innerHeight * 0.4);
  while (el && el.parentElement && el.getBoundingClientRect().width < innerWidth * 0.4) el = el.parentElement;
  if (!el) return false;
  const rect = el.getBoundingClientRect();
  const right = innerWidth - rect.right;
  return rect.left > innerWidth * 0.05 && Math.abs(rect.left - right) < innerWidth * 0.02;
})()`;

function visiblePage(content: HTMLElement): WebviewElement | undefined {
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

/** Whether a page is centred; a page that cannot say in time counts as centred. */
async function pageCentred(view: WebviewElement): Promise<boolean> {
  try {
    const answer = await Promise.race([
      // Throws before the page is attached and ready.
      view.executeJavaScript(PAGE_CENTRED),
      new Promise((resolve) => setTimeout(() => resolve(true), PAGE_READ_MS)),
    ]);
    return answer !== false;
  } catch {
    return true;
  }
}

/**
 * How far the content's main column moves within its box when the box's
 * width changes by `change`. Content in our own document is laid out at
 * once, so it is measured; a page is read before the content resizes.
 */
async function anchorShift(
  content: HTMLElement,
): Promise<(change: number) => number> {
  const centred = (change: number) => change / 2;
  const view = visiblePage(content);
  // The page sits at the box's left: a page is resized, not moved.
  if (view) return (await pageCentred(view)) ? centred : () => 0;
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
 * snapshots whose old and new images travel so its main column moves
 * straight from where it was to where it lands, and cross-fade. Snapshots
 * are GPU textures, so nothing re-lays out or waits on another process
 * while anything moves (ADR 0197).
 *
 * `update` always runs, animated or not. When `wanted` no longer holds by
 * the time the content has been read (the sidebar moved again), it runs
 * without a transition. Only the visible workspace animates.
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
    sidebar?.closest('[data-workspace-visible="false"]')
  ) {
    update();
    return;
  }
  const widthBefore = content.getBoundingClientRect().width;
  const start = (shift: (change: number) => number) => {
    if (!wanted()) {
      update();
      return;
    }
    pending?.skipTransition();
    if (settling) {
      settling.transition.skipTransition();
      settling.content.style.viewTransitionName = "";
    }
    const root = document.documentElement;
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
    settling = { transition, content };
    void transition.ready.catch(() => {
      /* A skipped transition still applied its update. */
    });
    void transition.finished.finally(() => {
      if (settling?.transition !== transition) return;
      settling = undefined;
      content.style.viewTransitionName = "";
      root.style.removeProperty("--content-shift");
    });
  };
  anchorShift(content).then(start, () => start((change) => change / 2));
}
