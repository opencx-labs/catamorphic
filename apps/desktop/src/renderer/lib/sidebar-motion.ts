import {
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  contentMovesWithSidebar,
  settleSidebarContent,
} from "./sidebar-transition.js";

/**
 * A sidebar moves the moment it is toggled and the content settles after it
 * (ADR 0200); closing from open, its items move first and the panel
 * follows 100ms later (lib/sidebar-leave.ts). The panel slides over the
 * content with a transform, so the compositor runs it without layout. Once
 * it has stopped, the content takes or gives back the sidebar's space in a
 * view transition that fades it in place from its old layout to its new one
 * (`settleSidebarContent`): the content (a web page in its own process, a
 * terminal, the editor) lays out at its new size once, behind snapshots,
 * and never while anything moves.
 *
 * `phase` is where the panel is:
 * - `closed`: off screen and invisible.
 * - `opening`: sliding in.
 * - `open`: in place.
 * - `closing`: sliding away.
 *
 * `docked` is whether the content makes room for the panel. It changes only
 * while the panel is still: after a docking sidebar opens or closes, and
 * when an open overlay becomes a docked sidebar.
 *
 * Content Work draws itself and lays out cheaply (a chat, a note, Settings)
 * is the exception (`push`): it moves with the panel instead. A toggle from
 * rest with nothing heavy showing beside the panel (`contentMovesWithSidebar`)
 * docks at once, and the sidebar's place in the row grows or shrinks with
 * the same timing as the slide, so the content's edge stays on the panel's
 * edge the whole way and the content lays out on every frame. A toggle that
 * turns a moving panel around keeps the motion it has.
 */
export type SidebarPhase = "closed" | "opening" | "open" | "closing";

export interface SidebarMotion {
  phase: SidebarPhase;
  /** Whether the sidebar takes space beside the content, as laid out. */
  docked: boolean;
  /** The content moves with the panel while it slides (see above). */
  push: boolean;
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
  const [push, setPush] = useState(false);
  const [settling, setSettling] = useState(false);
  const atRest = phase === "open" || phase === "closed";
  // Where the content belongs once the panel is still.
  const place = phase === "open" && dock;
  const latest = useRef({ atRest, place, push, dock, docked });
  latest.current = { atRest, place, push, dock, docked };

  const toggled = useRef(open);
  useLayoutEffect(() => {
    if (toggled.current !== open) {
      toggled.current = open;
      const current = latest.current;
      // Opening pushes when the open sidebar takes space; closing, when
      // the content is making room for it now (a compact window's sidebar
      // becomes an overlay as it closes, but still gives the space back).
      const pushing = current.atRest
        ? (open ? current.dock : current.docked) &&
          contentMovesWithSidebar(panel.current?.parentElement ?? null)
        : current.push;
      setPush(pushing);
      if (pushing) setDocked(open && current.dock);
    }
    setPhase((current) => {
      if (open) return current === "open" ? "open" : "opening";
      return current === "closed" ? "closed" : "closing";
    });
  }, [open, panel]);
  // A push lasts as long as the slide: at rest the sidebar's place changes
  // at once again (a resize, a settle).
  if (push && atRest) setPush(false);

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

  // One settle at a time. It reads where the content belongs when it applies
  // and leaves the content alone if the panel has started moving again;
  // another follows once the panel is still.
  useEffect(() => {
    if (!atRest || settling || docked === place) return;
    setSettling(true);
    settleSidebarContent({
      sidebar: panel.current?.parentElement ?? null,
      wanted: () => latest.current.atRest,
      update: () => {
        if (latest.current.atRest) setDocked(latest.current.place);
        setSettling(false);
      },
    });
  }, [atRest, settling, docked, place, panel]);

  return { phase, docked, push, settled: atRest && docked === place };
}
