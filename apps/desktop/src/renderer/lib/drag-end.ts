import { useEffect, useRef } from "react";

/**
 * Ends a drag whose dragend never arrived. A drag source that leaves the
 * page mid-drag (its tab closed, or its row gone from a list) hears its
 * dragend detached, out of React's reach, and whatever the drag put up would
 * stay: drop targets over a page take its every press. A pointer pressed, or
 * moved with no button held, comes only after the drag is over, so either
 * one ends it.
 */
export function useEndOfDrag(dragging: boolean, end: () => void): void {
  const latest = useRef(end);
  latest.current = end;
  useEffect(() => {
    if (!dragging) return;
    const over = (event: PointerEvent) => {
      if (event.type === "pointermove" && event.buttons !== 0) return;
      latest.current();
    };
    window.addEventListener("pointerdown", over, true);
    window.addEventListener("pointermove", over, true);
    return () => {
      window.removeEventListener("pointerdown", over, true);
      window.removeEventListener("pointermove", over, true);
    };
  }, [dragging]);
}
