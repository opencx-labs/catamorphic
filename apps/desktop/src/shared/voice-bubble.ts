import { type DockSpot, dockLanding } from "./dock-position.js";

/**
 * Voice's bubble (ADR 0236) rests along the bottom of the screen, left,
 * in the middle or right, where the person drags it, as the dock's
 * bubbles do. Its window is a square around the microphone, with room for
 * the shadow.
 */
export const VOICE_BUBBLE_SIZE = 64;
/** From the bottom and the sides of the screen to the bubble's window. */
export const VOICE_BUBBLE_MARGIN = 28;
/** Room around the resting spots for the glow of the one it would land on. */
const SPOTS_PAD = 16;

interface Area {
  x: number;
  y: number;
  width: number;
  height: number;
}

const SPOTS: readonly DockSpot[] = ["left", "center", "right"];

/** Where the bubble rests on a screen: its window's top, and each spot's left. */
export interface VoiceBubbleRest {
  y: number;
  x: Record<DockSpot, number>;
}

/** The resting spots along the bottom of a display's work area. */
export function voiceBubbleRest(area: Area): VoiceBubbleRest {
  const inset = Math.min(
    VOICE_BUBBLE_MARGIN,
    Math.max(0, (area.width - VOICE_BUBBLE_SIZE) / 2),
  );
  return {
    y: Math.max(
      area.y,
      Math.round(
        area.y + area.height - VOICE_BUBBLE_SIZE - VOICE_BUBBLE_MARGIN,
      ),
    ),
    x: {
      left: Math.round(area.x + inset),
      center: Math.round(area.x + (area.width - VOICE_BUBBLE_SIZE) / 2),
      right: Math.round(area.x + area.width - VOICE_BUBBLE_SIZE - inset),
    },
  };
}

/**
 * A dragged bubble: where its window is drawn, kept between the outer
 * spots, and the spot it lands on if let go now (the dock's landing: the
 * spot nearest its centre, past 40% of the way from the one it left).
 */
export function voiceBubbleDragAt(input: {
  rest: VoiceBubbleRest;
  /** The spot the drag started from. */
  from: DockSpot;
  /** Where the pointer has taken the window's left edge. */
  left: number;
}): { x: number; target: DockSpot } {
  const { x: at } = input.rest;
  const x = Math.round(Math.max(at.left, Math.min(at.right, input.left)));
  const target =
    dockLanding({
      from: input.from,
      centre: x + VOICE_BUBBLE_SIZE / 2,
      spots: SPOTS.map((spot) => ({
        spot,
        at: at[spot] + VOICE_BUBBLE_SIZE / 2,
      })),
    }) ?? input.from;
  return { x, target };
}

/**
 * The window that shows the resting spots while the bubble is dragged: the
 * band along the bottom of the display they sit in, and each spot within
 * it, where the bubble's window would be.
 */
export function voiceSpotsLayout(area: Area): {
  bounds: Area;
  top: number;
  slots: { spot: DockSpot; left: number }[];
} {
  const rest = voiceBubbleRest(area);
  return {
    bounds: {
      x: area.x,
      y: rest.y - SPOTS_PAD,
      width: area.width,
      height: VOICE_BUBBLE_SIZE + 2 * SPOTS_PAD,
    },
    top: SPOTS_PAD,
    slots: SPOTS.map((spot) => ({ spot, left: rest.x[spot] - area.x })),
  };
}

/** The bubble's page moves it, as the detached dock's moves its window. */
export interface VoiceBubbleDrag {
  phase: "start" | "move" | "end" | "cancel";
  screenX: number;
  reducedMotion: boolean;
}

/**
 * What the resting spots' page shows: the spots while a drag is under way,
 * the one the bubble would land on (or landed on, as they go), where each
 * sits in the page, and the colours the bubble wears.
 */
export interface VoiceSpotsState {
  shown: boolean;
  target: DockSpot;
  top: number;
  slots: { spot: DockSpot; left: number }[];
  profileId: string | null;
  projectId: string | null;
}
