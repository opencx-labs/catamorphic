/**
 * Whether a pointer or focus signal reflects the person's attention moving,
 * as opposed to the page moving under a parked pointer.
 *
 * The floating chat lurks (shrinks to a strip) while the agent works and
 * attention is elsewhere. Chromium re-hit-tests after layout changes and
 * fires boundary and focus events without any input: a sidebar section
 * landing, a panel sliding, an overlay appearing. Those must not read as
 * "the person looked away", or the chat folds up mid-reply on its own.
 */

/** How long after real input a boundary or focus event still counts as its consequence. */
export const ATTENTION_INPUT_WINDOW_MS = 400;

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * A mouseleave means the pointer left only when the pointer is outside the
 * box and moved recently. A leave with the pointer still inside is the box
 * changing under it (an overlay, a re-render); a leave without a recent move
 * is the box moving away from a parked pointer.
 */
export function pointerLeft(input: {
  clientX: number;
  clientY: number;
  box: Box | null;
  msSinceMove: number;
}): boolean {
  if (input.msSinceMove > ATTENTION_INPUT_WINDOW_MS) return false;
  if (!input.box) return true;
  return (
    input.clientX < input.box.left ||
    input.clientX > input.box.right ||
    input.clientY < input.box.top ||
    input.clientY > input.box.bottom
  );
}

/**
 * Focus landing outside the dock disengages it only when the person put it
 * there: a click or a key within the window. Programmatic focus (a landing
 * row claiming focus, a restored tab) says nothing about attention.
 */
export function focusMovedByPerson(msSinceInput: number): boolean {
  return msSinceInput <= ATTENTION_INPUT_WINDOW_MS;
}
