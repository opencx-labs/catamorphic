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
/** A margin or padding transition is the workspace frame: a few pixels. */
const INSET_GROWTH = 32;
/** Ends that never arrive (an interrupted or detached element) still end. */
const FALLBACK_MS = 600;

type State = { growth: number } | null;
const running = new Map<EventTarget, number>();
const listeners = new Set<(state: State) => void>();
let growth = 0;
let fallback: ReturnType<typeof setTimeout> | undefined;
let installed = false;

function notify() {
  const state = running.size ? { growth } : null;
  for (const listener of listeners) listener(state);
}

function settle() {
  running.clear();
  growth = 0;
  notify();
}

function onRun(event: TransitionEvent) {
  const target = event.target;
  if (
    !(target instanceof HTMLElement) ||
    !target.hasAttribute("data-layout-transition") ||
    !LAYOUT_PROPERTIES.has(event.propertyName)
  )
    return;
  if (event.propertyName === "width") {
    // The inline width is where it is going; the box is where it starts.
    const to = Number.parseFloat(target.style.width);
    const from = target.getBoundingClientRect().width;
    // A side panel shrinking gives its width to the content beside it.
    if (Number.isFinite(to)) growth += Math.max(0, from - to);
  } else {
    growth += INSET_GROWTH;
  }
  running.set(target, (running.get(target) ?? 0) + 1);
  clearTimeout(fallback);
  fallback = setTimeout(settle, FALLBACK_MS);
  notify();
}

function onEnd(event: TransitionEvent) {
  const count = running.get(event.target as EventTarget);
  if (!count || !LAYOUT_PROPERTIES.has(event.propertyName)) return;
  if (count > 1) running.set(event.target as EventTarget, count - 1);
  else running.delete(event.target as EventTarget);
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

/**
 * Hold `content` at one width while a layout transition runs. `container`
 * clips it meanwhile; the content should be absolutely placed at its left.
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
    let steady = container.current?.getBoundingClientRect().width ?? 0;
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            if (!restore && container.current)
              steady = container.current.getBoundingClientRect().width;
          });
    if (container.current) observer?.observe(container.current);
    const listener = (state: State) => {
      const element = content.current;
      const box = container.current;
      if (!state) {
        restore?.();
        restore = null;
        if (box) steady = box.getBoundingClientRect().width;
        return;
      }
      if (!element || !box) return;
      const width = `${Math.ceil(Math.max(steady, box.getBoundingClientRect().width + state.growth))}px`;
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
