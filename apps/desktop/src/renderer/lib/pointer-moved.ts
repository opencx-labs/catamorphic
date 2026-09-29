import type { MouseEvent } from "react";

/**
 * The pointer really moved. Chromium also sends mouse events when content
 * moves under a resting pointer (a list re-ranking as you type); those
 * carry no movement, and must not take the keyboard's highlight.
 */
export function pointerMoved(event: MouseEvent): boolean {
  return event.movementX !== 0 || event.movementY !== 0;
}
