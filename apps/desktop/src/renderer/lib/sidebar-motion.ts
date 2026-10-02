import {
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

/**
 * A sidebar slides over the content and only then takes its place beside it;
 * leaving, it gives its place back first and slides away once the content has
 * painted at its new size. The slide is a transform, so the compositor runs
 * it without layout, and the content beside it (a web page in its own
 * process, a terminal, the code editor) resizes once per toggle, while
 * nothing moves, instead of on every frame.
 *
 * - `closed`: off screen and invisible.
 * - `opening`: sliding in over the content.
 * - `open`: in place; beside the content when docking, over it otherwise.
 * - `undocking`: still in place over the content, which has just taken the
 *   sidebar's space and is painting at its new size.
 * - `closing`: sliding away.
 */
export type SidebarPhase =
  | "closed"
  | "opening"
  | "open"
  | "undocking"
  | "closing";

export interface SidebarMotion {
  phase: SidebarPhase;
  /** Whether the sidebar takes space beside the content, as laid out. */
  docked: boolean;
}

/** Frames the content gets to paint at its new size before the slide. */
const SETTLE_FRAMES = 2;

/**
 * `panel` is the element whose CSS transform transition carries the slide;
 * the phase follows that transition, so a slowed or interrupted slide stays
 * in step and one that never runs (a hidden workspace) ends at once.
 */
export function useSidebarMotion({
  open,
  dock,
  panel,
}: {
  open: boolean;
  /** Whether the open sidebar takes space beside the content. */
  dock: boolean;
  panel: RefObject<HTMLElement | null>;
}): SidebarMotion {
  const [phase, setPhase] = useState<SidebarPhase>(open ? "open" : "closed");
  const docked = phase === "open" && dock;
  // What the previous commit laid out: leaving a docked place gives the space
  // back before sliding, even when `dock` turned off in the same update.
  const dockedRef = useRef(docked);

  useLayoutEffect(() => {
    const wasDocked = dockedRef.current;
    setPhase((current) => {
      if (open)
        return current === "open" || current === "undocking"
          ? "open"
          : "opening";
      if (current === "open") return wasDocked ? "undocking" : "closing";
      if (current === "opening") return "closing";
      return current;
    });
  }, [open]);
  // After the effect above, so it reads the previous commit.
  useLayoutEffect(() => {
    dockedRef.current = docked;
  });

  useEffect(() => {
    if (phase !== "undocking") return;
    let remaining = SETTLE_FRAMES;
    let frame = 0;
    const tick = () => {
      remaining -= 1;
      if (remaining > 0) frame = requestAnimationFrame(tick);
      else
        setPhase((current) => (current === "undocking" ? "closing" : current));
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [phase]);

  useLayoutEffect(() => {
    if (phase !== "opening" && phase !== "closing") return;
    const settled = phase === "opening" ? "open" : "closed";
    const settle = () =>
      setPhase((current) => (current === phase ? settled : current));
    let current = true;
    const follow = () => {
      // Reading animations flushes style, which starts the slide's transition.
      const slide = panel.current
        ?.getAnimations?.()
        .find(
          (animation) =>
            animation instanceof CSSTransition &&
            animation.transitionProperty === "transform",
        );
      if (!slide) {
        settle();
        return;
      }
      slide.finished.then(
        () => {
          if (current) settle();
        },
        // Reversed: the next phase follows its own transition. Cancelled
        // with nothing replacing it: follow whatever runs now, or end.
        () => {
          if (current) follow();
        },
      );
    };
    follow();
    return () => {
      current = false;
    };
  }, [phase, panel]);

  return { phase, docked };
}
