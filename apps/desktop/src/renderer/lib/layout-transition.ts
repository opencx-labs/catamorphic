import { type RefObject, useEffect } from "react";

/**
 * Layout transitions (a sidebar opening or closing, the workspace frame
 * insetting) change the content area's size on every frame. Heavy content
 * re-lays out on each of those frames: a web page renders in its own process
 * and every frame waited for it (a GitHub tab took a sidebar toggle from
 * 14 ms frames to 40–55 ms). While a transition runs, such content holds one
 * width wide enough for both ends, clipped by its container, and resizes once
 * when the transition ends.
 *
 * Elements whose own size or margins animate carry `data-layout-transition`.
 * An overlaid one (absolutely or fixed placed) moves nothing beside it and is
 * ignored; content inside the animating element is not beside it either.
 */
const LAYOUT_PROPERTIES = new Set([
  "width",
  "margin-left",
  "margin-right",
  "padding-left",
  "padding-right",
  "left",
  "right",
]);
/** Ends that never arrive (an interrupted or detached element) still end. */
const FALLBACK_MS = 600;

type State = { growth: number; targets: ReadonlySet<Element> } | null;
const running = new Map<Element, number>();
const listeners = new Set<(state: State) => void>();
let growth = 0;
let fallback: ReturnType<typeof setTimeout> | undefined;
let installed = false;

function notify() {
  const state = running.size
    ? { growth, targets: new Set(running.keys()) }
    : null;
  for (const listener of listeners) listener(state);
}

function settle() {
  running.clear();
  growth = 0;
  notify();
}

/** How much wider the content beside `target` gets from this transition. */
function growthFrom(target: HTMLElement, property: string): number {
  // The inline value is where it is going; the computed one where it starts.
  const to = Number.parseFloat(target.style.getPropertyValue(property));
  if (property === "width") {
    const from = target.getBoundingClientRect().width;
    // A side panel shrinking gives its width to the content beside it.
    return Number.isFinite(to) ? Math.max(0, from - to) : 0;
  }
  const from = Number.parseFloat(
    getComputedStyle(target).getPropertyValue(property),
  );
  if (Number.isFinite(to) && Number.isFinite(from))
    return Math.max(0, from - to);
  // A class-driven inset: a few pixels at most.
  return 16;
}

function onRun(event: TransitionEvent) {
  const target = event.target;
  if (
    !(target instanceof HTMLElement) ||
    !target.hasAttribute("data-layout-transition") ||
    !LAYOUT_PROPERTIES.has(event.propertyName)
  )
    return;
  const { position } = getComputedStyle(target);
  if (position === "absolute" || position === "fixed") return;
  growth += growthFrom(target, event.propertyName);
  running.set(target, (running.get(target) ?? 0) + 1);
  clearTimeout(fallback);
  fallback = setTimeout(settle, FALLBACK_MS);
  notify();
}

function onEnd(event: TransitionEvent) {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const count = running.get(target);
  if (!count || !LAYOUT_PROPERTIES.has(event.propertyName)) return;
  if (count > 1) running.set(target, count - 1);
  else running.delete(target);
  if (running.size) return;
  clearTimeout(fallback);
  settle();
}

function install() {
  if (installed || typeof document === "undefined") return;
  installed = true;
  document.addEventListener("transitionrun", onRun, true);
  document.addEventListener("transitionend", onEnd, true);
  document.addEventListener("transitioncancel", onEnd, true);
}

/** The width content inside `box` lays out in: its padding box minus padding. */
function contentWidth(box: HTMLElement): number {
  const style = getComputedStyle(box);
  return (
    box.getBoundingClientRect().width -
    (Number.parseFloat(style.paddingLeft) || 0) -
    (Number.parseFloat(style.paddingRight) || 0) -
    (Number.parseFloat(style.borderLeftWidth) || 0) -
    (Number.parseFloat(style.borderRightWidth) || 0)
  );
}

/**
 * Hold `content` at one width while a layout transition beside it runs.
 * `container` clips it meanwhile; the content should sit at its left.
 */
export function useSteadyWidthDuringLayoutTransitions(
  content: RefObject<HTMLElement | null>,
  container: RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    install();
    let restore: (() => void) | null = null;
    // The width before the transition's first frame: by the time the run
    // event arrives, the box has already taken one step.
    let steady = 0;
    let observed: HTMLElement | null = null;
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            if (!restore && observed && observed.getClientRects().length)
              steady = contentWidth(observed);
          });
    // Containers can mount after this effect (a screen still loading).
    const observe = () => {
      const box = container.current;
      if (!box || box === observed) return;
      if (observed) observer?.unobserve(observed);
      observed = box;
      observer?.observe(box);
      if (box.getClientRects().length) steady = contentWidth(box);
    };
    observe();
    const listener = (state: State) => {
      const element = content.current;
      observe();
      const box = container.current;
      if (!state) {
        restore?.();
        restore = null;
        if (box?.getClientRects().length) steady = contentWidth(box);
        return;
      }
      if (
        !element ||
        !box ||
        // A hidden tab has no width to keep; it lays out when shown.
        box.getClientRects().length === 0 ||
        // Content inside the animating element does not change beside it.
        [...state.targets].some((target) => target.contains(box))
      )
        return;
      const width = `${Math.ceil(Math.max(steady, contentWidth(box) + state.growth))}px`;
      if (!restore) {
        const previousWidth = element.style.width;
        const previousOverflow = box.style.overflow;
        restore = () => {
          element.style.width = previousWidth;
          box.style.overflow = previousOverflow;
        };
      }
      box.style.overflow = "hidden";
      element.style.width = width;
    };
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      observer?.disconnect();
      restore?.();
    };
  }, [content, container]);
}
