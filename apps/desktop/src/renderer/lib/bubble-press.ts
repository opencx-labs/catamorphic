/**
 * A press on voice's floating bubble (ADR 0236) is a tap, a hold or a
 * drag, and reaches voice only once it is one of the first two: a hold
 * stops the agent talking, and moving the bubble must not. Still for this
 * long, it is a hold; voice keeps what the person said from just before
 * (its preroll), so the wait loses none of it.
 */
export const BUBBLE_HOLD_MS = 250;
/** How far the pointer goes, still waiting, before the press is a drag. */
export const BUBBLE_DRAG_SLOP = 5;

export type BubblePress =
  | { kind: "idle" }
  /** Down, not yet a tap, a hold or a drag. */
  | { kind: "waiting"; x: number; at: number }
  /** Voice has the press: it hears the person while it is held. */
  | { kind: "held" }
  | { kind: "dragging" };

export type BubblePressEvent =
  | { kind: "down"; x: number; at: number }
  | { kind: "move"; x: number }
  /** The press has been still for BUBBLE_HOLD_MS. */
  | { kind: "still" }
  | { kind: "up"; x: number }
  | { kind: "cancel" };

export type BubblePressEffect =
  /** Voice's press goes down, as of when the pointer did. */
  | { kind: "press"; at: number }
  | { kind: "release" }
  | {
      kind: "drag";
      phase: "start" | "move" | "end" | "cancel";
      screenX: number;
    };

/** The press after an event, and what it asks of voice and the bubble. */
export function bubblePress(
  press: BubblePress,
  event: BubblePressEvent,
): { press: BubblePress; effects: BubblePressEffect[] } {
  const idle: BubblePress = { kind: "idle" };
  switch (event.kind) {
    case "down":
      return press.kind === "idle"
        ? { press: { kind: "waiting", x: event.x, at: event.at }, effects: [] }
        : { press, effects: [] };
    case "still":
      return press.kind === "waiting"
        ? {
            press: { kind: "held" },
            effects: [{ kind: "press", at: press.at }],
          }
        : { press, effects: [] };
    case "move":
      if (press.kind === "dragging")
        return {
          press,
          effects: [{ kind: "drag", phase: "move", screenX: event.x }],
        };
      if (
        press.kind !== "waiting" ||
        Math.abs(event.x - press.x) < BUBBLE_DRAG_SLOP
      )
        return { press, effects: [] };
      return {
        press: { kind: "dragging" },
        effects: [
          { kind: "drag", phase: "start", screenX: press.x },
          { kind: "drag", phase: "move", screenX: event.x },
        ],
      };
    case "up":
      if (press.kind === "waiting")
        return {
          press: idle,
          effects: [{ kind: "press", at: press.at }, { kind: "release" }],
        };
      if (press.kind === "held")
        return { press: idle, effects: [{ kind: "release" }] };
      if (press.kind === "dragging")
        return {
          press: idle,
          effects: [{ kind: "drag", phase: "end", screenX: event.x }],
        };
      return { press, effects: [] };
    case "cancel":
      if (press.kind === "held")
        return { press: idle, effects: [{ kind: "release" }] };
      if (press.kind === "dragging")
        return {
          press: idle,
          effects: [{ kind: "drag", phase: "cancel", screenX: 0 }],
        };
      return { press: idle, effects: [] };
  }
}
