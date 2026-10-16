import { useEffect, useState } from "react";
import { TAB_DRAG_TYPE } from "./tab-drag.js";

/** How long a revealed drop target stays after the drop, for what lands. */
const DROP_SETTLE_MS = 600;

/**
 * A page, chat or row is being dragged in this window. Revealing a target
 * waits a tick: moving the dragged row during dragstart cancels the drag.
 */
export function useDraggingTab(): boolean {
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    let timer: number | undefined;
    const start = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes(TAB_DRAG_TYPE)) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setDragging(true), 0);
    };
    const end = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setDragging(false), DROP_SETTLE_MS);
    };
    document.addEventListener("dragstart", start);
    document.addEventListener("dragend", end);
    document.addEventListener("drop", end);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("dragstart", start);
      document.removeEventListener("dragend", end);
      document.removeEventListener("drop", end);
    };
  }, []);
  return dragging;
}
