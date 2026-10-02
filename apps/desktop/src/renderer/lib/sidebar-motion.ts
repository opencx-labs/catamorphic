import {
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { transitionSidebarToggle } from "./sidebar-transition.js";

/**
 * A sidebar moves the moment it is toggled and the content settles after it
 * (ADR 0197). The panel slides over the content with a transform, so the
 * compositor runs it without layout. Once it has stopped, the content takes
 * or gives back the sidebar's space in a view transition that morphs it
 * from its old layout to its new one (`transitionSidebarToggle`): the
 * content (a web page in its own process, a terminal, the editor) lays out
 * at its new size once, behind snapshots, and never while anything moves.
 *
 * `phase` is where the panel is:
 * - `closed`: off screen and invisible.
 * - `opening`: sliding in.
 * - `open`: in place.
 * - `closing`: sliding away.
 *
 * `docked` is whether the content makes room for the panel. It changes only
 * at rest: after a docking sidebar opens, and after one closes.
 */
export type SidebarPhase = "closed" | "opening" | "open" | "closing";

export interface SidebarMotion {
  phase: SidebarPhase;
  /** Whether the sidebar takes space beside the content, as laid out. */
  docked: boolean;
}

/**
 * `panel` is the element whose CSS transform transition carries the slide;
 * the phase follows that transition, so a slowed or interrupted slide stays
 * in step and one that never runs ends at once.
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
}): SidebarMotion & {
  /** The panel is still and the content is where it belongs. */
  settled: boolean;
} {
  const [phase, setPhase] = useState<SidebarPhase>(open ? "open" : "closed");
  const [docked, setDocked] = useState(open && dock);
  const [morphing, setMorphing] = useState(false);
  const atRest = phase === "open" || phase === "closed";
  // Where the content belongs once the panel is still.
  const place = phase === "open" && dock;
  const latest = useRef({ atRest, place });
  latest.current = { atRest, place };

  useLayoutEffect(() => {
    setPhase((current) => {
      if (open) return current === "open" ? "open" : "opening";
      return current === "closed" ? "closed" : "closing";
    });
  }, [open]);

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

  // One morph at a time. It reads where the content belongs when it applies
  // and leaves the content alone if the panel has started moving again;
  // another follows once the panel is still.
  useEffect(() => {
    if (!atRest || morphing || docked === place) return;
    setMorphing(true);
    transitionSidebarToggle({
      sidebar: panel.current?.parentElement ?? null,
      update: () => {
        if (latest.current.atRest) setDocked(latest.current.place);
        setMorphing(false);
      },
    });
  }, [atRest, morphing, docked, place, panel]);

  return { phase, docked, settled: atRest && docked === place };
}
