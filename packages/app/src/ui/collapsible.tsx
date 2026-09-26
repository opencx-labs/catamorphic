import { type ReactNode, useLayoutEffect, useRef } from "react";

/** Height changes this close together are one continuous change (a resize
 * drag reflowing text), which the box follows instead of chasing. */
const CONTINUOUS_MS = 120;

/**
 * The host's structural motion, shared by every nesting level: opening,
 * closing, and any change in what it holds. Loading rows becoming rows, an
 * empty sentence becoming a list: the box tweens to its content's measured
 * height on `--cat-motion-base` and the standard curve instead of snapping,
 * so neighbours slide. While something inside is already animating its own
 * height (a tree sliding its rows, a nested collapsible) or the height is
 * changing continuously, the box follows it exactly so the two never chase.
 * Closed content is inert and hidden from assistive tech but stays mounted,
 * which keeps form state and scroll positions.
 */
export function Collapsible({
  open,
  children,
  className,
}: {
  open: boolean;
  children: ReactNode;
  className?: string;
}) {
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const lastChange = useRef(0);
  const settled = useRef(false);
  // Hidden with an ancestor (an inactive tab, a background view) the content
  // measures 0. Keep the last height instead, and take the real one without
  // a tween once it is shown again.
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
    const duration = () => {
      if (
        typeof matchMedia === "function" &&
        matchMedia("(prefers-reduced-motion: reduce)").matches
      )
        return "0ms";
      return (
        getComputedStyle(box).getPropertyValue("--cat-motion-base").trim() ||
        "200ms"
      );
    };
    const apply = () => {
      if (content.getClientRects().length === 0) {
        wasHidden.current = true;
        return;
      }
      const target = open ? content.offsetHeight : 0;
      const reappeared = wasHidden.current;
      wasHidden.current = false;
      if (box.style.height === `${target}px`) return;
      const now = performance.now();
      const follow =
        !settled.current ||
        reappeared ||
        now - lastChange.current < CONTINUOUS_MS ||
        animatingHeight(content);
      lastChange.current = now;
      const write = () => {
        const base = duration();
        // transition-property is [height, opacity]; the fade keeps its tween.
        box.style.transitionDuration = `${follow ? "0ms" : base}, ${base}`;
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
      className={className ? `cat-collapsible ${className}` : "cat-collapsible"}
      data-state={open ? "open" : "closed"}
      data-collapsible={open ? "open" : "closed"}
      inert={!open}
      aria-hidden={!open}
      style={{
        overflow: "hidden",
        opacity: open ? 1 : 0,
        transitionProperty: "height, opacity",
        transitionTimingFunction:
          "var(--ease-standard, cubic-bezier(0.2, 0, 0, 1))",
      }}
    >
      <div
        ref={inner}
        className="cat-collapsible-inner"
        style={{ display: "flow-root" }}
      >
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
        .some((keyframe) =>
          Object.keys(keyframe).some((key) =>
            SIZE_PROPERTIES.has(
              key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`),
            ),
          ),
        )
    );
  });
}
