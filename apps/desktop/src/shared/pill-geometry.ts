import {
  type DockSpot,
  dockLanding,
  dockPosition,
  fitDockSize,
} from "./dock-position.js";

/**
 * Where the pill rests on the desktop (ADR 0242): an edge of a display,
 * and along the bottom its collapsed corner and open placement. Saved as
 * these names and a display id, never as coordinates.
 */
export type PillEdge = "bottom" | "left" | "right" | "top";
export const PILL_EDGES: readonly PillEdge[] = [
  "bottom",
  "left",
  "right",
  "top",
];

export interface PillRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A camera cutout, in points from its display's left edge and top. */
export interface PillNotch {
  x: number;
  width: number;
  height: number;
}

export interface PillDisplay {
  id: number;
  bounds: PillRect;
  workArea: PillRect;
  /** The camera cutout; null on a display without one. */
  notch: PillNotch | null;
}

export interface PillRest {
  edge: PillEdge;
  side: "left" | "right";
  placement: DockSpot;
}

/** The pill's distance from the screen edge it rests on. */
export const PILL_MARGIN = 12;
/** How far ahead a throw carries the drop (Companion's 0.15 s). */
const THROW_S = 0.15;
const THROW_MAX = 300;

const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

/**
 * The window that holds the pill at rest. The bottom keeps the dock's own
 * rule (dock-position.ts), inside the front Work window's chat region when
 * it follows one. The sides centre the window vertically on the work area,
 * flush with the edge (the pill keeps its margin inside). The top centres
 * it on the notch, over the menu bar, or else under the menu bar.
 */
export function pillBounds(input: {
  rest: PillRest;
  display: PillDisplay;
  /** Where a bottom pill rests instead of the work area (a chat region). */
  region?: PillRect;
  width: number;
  height: number;
  /** The strip is open (or a chat is): placement rules, not the corner. */
  expanded: boolean;
}): PillRect {
  const { rest, display, expanded } = input;
  if (rest.edge === "bottom") {
    const area = input.region ?? display.workArea;
    const size = fitDockSize(input, area);
    return {
      ...dockPosition({
        area,
        ...size,
        side:
          expanded && rest.placement !== "center" ? rest.placement : rest.side,
        centered: expanded && rest.placement === "center",
      }),
      ...size,
    };
  }
  if (rest.edge === "top" && display.notch) {
    const bounds = display.bounds;
    const size = fitDockSize(input, bounds);
    const centre = bounds.x + display.notch.x + display.notch.width / 2;
    return {
      x: Math.round(
        clamp(
          centre - size.width / 2,
          bounds.x,
          bounds.x + bounds.width - size.width,
        ),
      ),
      y: bounds.y,
      ...size,
    };
  }
  const area = display.workArea;
  const size = fitDockSize(input, area);
  if (rest.edge === "top")
    return {
      x: Math.round(area.x + (area.width - size.width) / 2),
      y: area.y,
      ...size,
    };
  const y = Math.round(area.y + (area.height - size.height) / 2);
  return rest.edge === "left"
    ? { x: area.x, y, ...size }
    : { x: area.x + area.width - size.width, y, ...size };
}

/** The display holding a point, else the one nearest it. */
export function pickDisplay<D extends Pick<PillDisplay, "bounds">>(
  displays: readonly D[],
  point: { x: number; y: number },
): D | undefined {
  let nearest: D | undefined;
  let best = Number.POSITIVE_INFINITY;
  for (const display of displays) {
    const { x, y, width, height } = display.bounds;
    const dx = Math.max(x - point.x, 0, point.x - (x + width - 1));
    const dy = Math.max(y - point.y, 0, point.y - (y + height - 1));
    const distance = Math.hypot(dx, dy);
    if (distance < best) {
      best = distance;
      nearest = display;
    }
  }
  return nearest;
}

/**
 * Where a dropped pill lands: on the display under the pointer, the edge
 * nearest the point the throw carries it to (ties go bottom, left, right,
 * top), and along the bottom the corner or placement nearest the pill's
 * centre, leaving its own after 40% of the way (dock-position.ts).
 */
export function pillLanding(input: {
  displays: readonly PillDisplay[];
  pointer: { x: number; y: number };
  /** Release speed, in points per second. */
  velocity: { x: number; y: number };
  from: PillRest;
  /** The pill window's centre when let go, for the bottom's spots. */
  centre: { x: number; y: number };
  /** The pill window's size, for where each bottom spot rests. */
  width: number;
  height: number;
  expanded: boolean;
  /**
   * Where the bottom's spots rest instead of the work area: the chat region
   * of the Work window a bottom pill follows, when on this display.
   */
  bottomArea?: PillRect;
  /** The edge it stays on, when it may only move along one. */
  edge?: PillEdge;
}): (PillRest & { displayId: number }) | undefined {
  const display = pickDisplay(input.displays, input.pointer);
  if (!display) return undefined;
  const aim = {
    x:
      input.pointer.x +
      clamp(input.velocity.x * THROW_S, -THROW_MAX, THROW_MAX),
    y:
      input.pointer.y +
      clamp(input.velocity.y * THROW_S, -THROW_MAX, THROW_MAX),
  };
  const area = display.workArea;
  // The notch belongs to the top edge: it sits in the menu bar.
  const top = display.notch ? display.bounds.y : area.y;
  const distances: Record<PillEdge, number> = {
    bottom: area.y + area.height - aim.y,
    left: aim.x - area.x,
    right: area.x + area.width - aim.x,
    top: aim.y - top,
  };
  const edge =
    input.edge ??
    PILL_EDGES.reduce((best, next) =>
      distances[next] < distances[best] ? next : best,
    );
  if (edge !== "bottom") return { ...input.from, edge, displayId: display.id };
  const spotsArea = input.bottomArea ?? area;
  const restsAt = (spot: DockSpot) =>
    dockPosition({
      area: spotsArea,
      width: input.width,
      height: input.height,
      side: spot === "right" ? "right" : "left",
      centered: spot === "center",
    }).x +
    input.width / 2;
  const centre = clamp(
    input.centre.x,
    spotsArea.x + input.width / 2,
    spotsArea.x + spotsArea.width - input.width / 2,
  );
  // Arriving from another edge, the nearest spot: no spot of the bottom's
  // is the one it is leaving.
  const along = <Spot extends DockSpot>(
    from: DockSpot,
    spots: readonly { spot: Spot; at: number }[],
  ): Spot | undefined =>
    input.from.edge === "bottom"
      ? dockLanding({ from, centre, spots })
      : spots.reduce((best, next) =>
          Math.abs(next.at - centre) < Math.abs(best.at - centre) ? next : best,
        ).spot;
  const corners = [
    { spot: "left" as const, at: restsAt("left") },
    { spot: "right" as const, at: restsAt("right") },
  ];
  const side = input.expanded
    ? input.from.side
    : (along(input.from.side, corners) ?? input.from.side);
  const placement = input.expanded
    ? (along(input.from.placement, [
        ...corners,
        { spot: "center" as const, at: restsAt("center") },
      ]) ?? input.from.placement)
    : input.from.placement;
  return { edge, side, placement, displayId: display.id };
}

/** One place a dragged pill can land, for the overlay that shows them. */
export interface PillTarget {
  key: string;
  rest: PillRest;
  /** In the display's own coordinates (its bounds' origin at 0,0). */
  rect: PillRect;
  /** Drawn as the notch's island rather than a pill. */
  notch?: boolean;
}

/** A spot's capsule, long side along its edge. */
const SPOT_LONG = 96;
const SPOT_SHORT = 44;

/**
 * Every place a pill held over this display can land. The bottom offers
 * its corners for the folded pill and its three placements for the open
 * strip; each side its centre; the top the notch, or its centre.
 */
export function pillTargets(input: {
  display: PillDisplay;
  rest: PillRest;
  expanded: boolean;
}): PillTarget[] {
  const { display, rest, expanded } = input;
  const area = display.workArea;
  const ox = display.bounds.x;
  const oy = display.bounds.y;
  const left = area.x - ox + PILL_MARGIN;
  const right = area.x - ox + area.width - PILL_MARGIN;
  const bottom = area.y - oy + area.height - PILL_MARGIN;
  const middle = area.y - oy + area.height / 2;
  const bottomSpots: PillTarget[] = (
    expanded
      ? (["left", "center", "right"] as const)
      : (["left", "right"] as const)
  ).map((spot) => ({
    key: `bottom-${spot}`,
    rest: expanded
      ? { ...rest, edge: "bottom", placement: spot }
      : { ...rest, edge: "bottom", side: spot === "left" ? "left" : "right" },
    rect: {
      x:
        spot === "left"
          ? left
          : spot === "right"
            ? right - SPOT_LONG
            : area.x - ox + (area.width - SPOT_LONG) / 2,
      y: bottom - SPOT_SHORT,
      width: SPOT_LONG,
      height: SPOT_SHORT,
    },
  }));
  const notch = display.notch;
  const wing = notch ? notch.height + 8 : 0;
  return [
    ...bottomSpots,
    {
      key: "left",
      rest: { ...rest, edge: "left" },
      rect: {
        x: left,
        y: middle - SPOT_LONG / 2,
        width: SPOT_SHORT,
        height: SPOT_LONG,
      },
    },
    {
      key: "right",
      rest: { ...rest, edge: "right" },
      rect: {
        x: right - SPOT_SHORT,
        y: middle - SPOT_LONG / 2,
        width: SPOT_SHORT,
        height: SPOT_LONG,
      },
    },
    notch
      ? {
          key: "top",
          rest: { ...rest, edge: "top" },
          rect: {
            x: notch.x - wing,
            y: 0,
            width: notch.width + 2 * wing,
            height: notch.height,
          },
          notch: true,
        }
      : {
          key: "top",
          rest: { ...rest, edge: "top" },
          rect: {
            x: area.x - ox + (area.width - SPOT_LONG) / 2,
            y: area.y - oy + PILL_MARGIN,
            width: SPOT_LONG,
            height: SPOT_SHORT,
          },
        },
  ];
}

/** The target a rest lands in, for lighting it in the overlay. */
export function pillTargetKey(rest: PillRest, expanded: boolean): string {
  if (rest.edge !== "bottom") return rest.edge;
  return expanded ? `bottom-${rest.placement}` : `bottom-${rest.side}`;
}

/**
 * The target an arrow key moves to: the one most nearly that way from the
 * current one (within 67.5°), the nearer of two equally aligned.
 */
export function pillTargetToward(
  targets: readonly PillTarget[],
  fromKey: string,
  direction: "left" | "right" | "up" | "down",
): PillTarget | undefined {
  const from = targets.find((target) => target.key === fromKey);
  if (!from) return undefined;
  const centre = (rect: PillRect) => ({
    x: rect.x + rect.width / 2,
    y: rect.y + rect.height / 2,
  });
  const origin = centre(from.rect);
  const want = { left: 180, right: 0, up: -90, down: 90 }[direction];
  let best: PillTarget | undefined;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const target of targets) {
    if (target === from) continue;
    const at = centre(target.rect);
    const dx = at.x - origin.x;
    const dy = at.y - origin.y;
    const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
    const deviation = Math.abs(((angle - want + 540) % 360) - 180);
    if (deviation > 67.5) continue;
    const score = deviation * 10_000 + Math.hypot(dx, dy);
    if (score < bestScore) {
      bestScore = score;
      best = target;
    }
  }
  return best;
}

/**
 * One display's report from `NSScreen` (main/pill-notch.ts): its frame,
 * the menu bar's areas either side of the cutout, and the safe area's top.
 * Rects are `[x, y, width, height]` in AppKit's bottom-left coordinates.
 */
export interface NotchReport {
  id: number;
  frame: [number, number, number, number];
  left: [number, number, number, number];
  right: [number, number, number, number];
  top: number;
}

/** The cutout a report describes, or null for a display without one. */
export function notchFromReport(report: NotchReport): PillNotch | null {
  const width = report.frame[2] - report.left[2] - report.right[2];
  if (report.left[2] <= 0 || report.right[2] <= 0 || width <= 0) return null;
  if (report.top <= 0) return null;
  return { x: report.left[2], width, height: report.top };
}

/** A notch's usual width (14-inch MacBook Pro) when macOS gives none. */
const FALLBACK_NOTCH_WIDTH = 185;

/**
 * Without a report: a built-in display whose menu bar is at least 30
 * points tall has a cutout (notchless menu bars are 24), centred.
 */
export function guessNotch(display: {
  internal: boolean;
  bounds: PillRect;
  workArea: PillRect;
}): PillNotch | null {
  const menuBar = display.workArea.y - display.bounds.y;
  if (!display.internal || menuBar < 30) return null;
  return {
    x: Math.round((display.bounds.width - FALLBACK_NOTCH_WIDTH) / 2),
    width: FALLBACK_NOTCH_WIDTH,
    height: menuBar,
  };
}

/** Critically damped glide (stiffness 500, damping ≈45, Companion's). */
const OMEGA = Math.sqrt(500);
/** Long enough to land within a point of a target 2000 points away. */
export const PILL_GLIDE_MS = 460;

/**
 * Where a glide from `from` to `to` is after `ms`, starting at `velocity`
 * (points per second, the throw), never overshooting by more than the
 * throw carries it.
 */
export function pillGlide(input: {
  from: number;
  to: number;
  velocity: number;
  ms: number;
}): number {
  if (input.ms >= PILL_GLIDE_MS) return input.to;
  const t = input.ms / 1000;
  const delta = input.from - input.to;
  const velocity = clamp(input.velocity, -800, 800);
  return (
    input.to + (delta + (velocity + OMEGA * delta) * t) * Math.exp(-OMEGA * t)
  );
}
