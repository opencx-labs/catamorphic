import { type ReactNode, useLayoutEffect, useRef } from "react";
import { motionMs } from "../lib/motion.js";

/** Height changes this close together are one continuous change (a resize
 * drag reflowing text), which the box follows instead of chasing. */
const CONTINUOUS_MS = 120;

/**
 * The sidebar's structural motion, shared by every nesting level: opening,
 * closing, and any change in what it holds. Skeleton rows becoming rows, an
 * empty sentence becoming a list, a pinned area emptying: the box tweens to
 * its content's measured height over 200 ms instead of snapping. While
 * something inside is already animating its own height (a tree sliding its
 * rows, a nested collapsible) or the height is changing continuously, the box
 * follows it exactly so the two never chase each other.
 */
export function Collapsible({
  open,
  children,
}: {
  open: boolean;
  children: ReactNode;
}) {
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const lastChange = useRef(0);
  const settled = useRef(false);
  // Hidden with an ancestor (an inactive sidebar tab, a background
  // workspace) the content measures 0. Keep the last height instead, and
  // take the real one without a tween once it is shown again.
  const wasHidden = useRef(false);

  useLayoutEffect(() => {
    const box = outer.current;
    const content = inner.current;
    if (!box || !content) return;
    // A box inside another one writes its height on the next frame. Written
    // inside the observer callback, it would resize the outer box's content
    // (shallower in the tree) after the browser gathered this pass, which
    // Chromium reports as an undelivered-notification loop error. The
    // outermost box writes at once, so nesting costs one frame, not one per
    // level.
    const nested = Boolean(box.parentElement?.closest("[data-collapsible]"));
    let frame = 0;
    const apply = () => {
      if (content.getClientRects().length === 0) {
        wasHidden.current = true;
        return;
      }
      const target = open ? content.offsetHeight : 0;
      const current = box.style.height;
      const reappeared = wasHidden.current;
      wasHidden.current = false;
      if (current === `${target}px`) return;
      const now = performance.now();
      const follow =
        !settled.current ||
        reappeared ||
        now - lastChange.current < CONTINUOUS_MS ||
        animatingHeight(content);
      lastChange.current = now;
      const write = () => {
        // transition-property is [height, opacity]; the fade keeps its tween.
        box.style.transitionDuration = `${follow ? 0 : motionMs(200)}ms, ${motionMs(200)}ms`;
        box.style.height = `${target}px`;
      };
      cancelAnimationFrame(frame);
      if (nested && settled.current) frame = requestAnimationFrame(write);
      else write();
    };
    apply();
    settled.current = true;
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(apply);
    observer.observe(content);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [open]);

  return (
    <div
      ref={outer}
      className="overflow-hidden transition-[height,opacity] ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none"
      style={{ opacity: open ? 1 : 0 }}
      inert={!open}
      aria-hidden={!open}
      data-collapsible={open ? "open" : "closed"}
    >
      <div ref={inner} className="flow-root">
        {children}
      </div>
    </div>
  );
}

const SIZE_PROPERTIES = new Set([
  "height",
  "max-height",
  "min-height",
  "grid-template-rows",
]);

function animatingHeight(root: Element): boolean {
  if (typeof root.getAnimations !== "function") return false;
  return root.getAnimations({ subtree: true }).some((animation) => {
    if (animation.playState !== "running") return false;
    if (
      typeof CSSTransition !== "undefined" &&
      animation instanceof CSSTransition
    )
      return SIZE_PROPERTIES.has(animation.transitionProperty);
    const effect = animation.effect;
    return (
      typeof KeyframeEffect !== "undefined" &&
      effect instanceof KeyframeEffect &&
      effect
        .getKeyframes()
        .some((frame) =>
          Object.keys(frame).some((key) =>
            SIZE_PROPERTIES.has(
              key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`),
            ),
          ),
        )
    );
  });
}
