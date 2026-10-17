import { describe, expect, it } from "vitest";
import {
  guessNotch,
  type NotchReport,
  notchFromReport,
  PILL_EDGES,
  PILL_GLIDE_MS,
  PILL_MARGIN,
  type PillDisplay,
  type PillEdge,
  type PillRect,
  type PillRest,
  pickDisplay,
  pillBounds,
  pillGlide,
  pillLanding,
  pillTargetKey,
  pillTargets,
  pillTargetToward,
} from "./pill-geometry.js";

/*
 * The pill's geometry (ADR 0242) over a matrix of real display layouts:
 * a 14-inch and a 16-inch MacBook Pro (their notches as macOS reports
 * them), external displays left of, right of and above them (negative
 * origins), a portrait display, a Linux panel at the top and a macOS Dock
 * on the left. Every case checks invariants rather than one coordinate.
 */

const rect = (x: number, y: number, width: number, height: number) => ({
  x,
  y,
  width,
  height,
});

const DISPLAYS = {
  // This MacBook Pro, as NSScreen reports it (left area 663 wide, right 664).
  macbook14: {
    id: 1,
    bounds: rect(0, 0, 1512, 982),
    workArea: rect(0, 32, 1512, 950),
    notch: { x: 663, width: 185, height: 32 },
  },
  macbook14Dock: {
    id: 2,
    bounds: rect(0, 0, 1512, 982),
    workArea: rect(0, 32, 1512, 880),
    notch: { x: 663, width: 185, height: 32 },
  },
  macbook16: {
    id: 3,
    bounds: rect(0, 0, 1728, 1117),
    workArea: rect(0, 38, 1728, 1079),
    notch: { x: 770, width: 188, height: 38 },
  },
  externalRightAbove: {
    id: 4,
    bounds: rect(1512, -300, 2560, 1440),
    workArea: rect(1512, -275, 2560, 1415),
    notch: null,
  },
  externalLeft: {
    id: 5,
    bounds: rect(-1920, 0, 1920, 1080),
    workArea: rect(-1920, 25, 1920, 1055),
    notch: null,
  },
  portraitBelow: {
    id: 6,
    bounds: rect(0, 982, 1080, 1920),
    workArea: rect(0, 1007, 1080, 1895),
    notch: null,
  },
  linuxPanelTop: {
    id: 7,
    bounds: rect(0, 0, 1280, 720),
    workArea: rect(0, 32, 1280, 688),
    notch: null,
  },
  dockLeft: {
    id: 8,
    bounds: rect(0, 0, 1440, 900),
    workArea: rect(72, 25, 1368, 875),
    notch: null,
  },
  small: {
    id: 9,
    bounds: rect(0, 0, 1024, 640),
    workArea: rect(0, 25, 1024, 615),
    notch: null,
  },
} satisfies Record<string, PillDisplay>;

/** The windows DockHost asks for, per edge and state. */
const SIZES: Record<
  PillEdge,
  { state: string; width: number; height: number; expanded: boolean }[]
> = {
  bottom: [
    { state: "folded", width: 142, height: 124, expanded: false },
    { state: "strip", width: 600, height: 124, expanded: true },
    { state: "chat", width: 780, height: 560, expanded: true },
  ],
  top: [
    { state: "folded", width: 360, height: 128, expanded: false },
    { state: "strip", width: 600, height: 128, expanded: true },
    { state: "chat", width: 780, height: 600, expanded: true },
  ],
  left: [
    { state: "folded", width: 236, height: 148, expanded: false },
    { state: "strip", width: 236, height: 420, expanded: true },
    { state: "chat", width: 612, height: 560, expanded: true },
  ],
  right: [
    { state: "folded", width: 236, height: 148, expanded: false },
    { state: "strip", width: 236, height: 420, expanded: true },
    { state: "chat", width: 612, height: 560, expanded: true },
  ],
};

const RESTS: PillRest[] = PILL_EDGES.flatMap((edge) =>
  (["left", "right"] as const).flatMap((side) =>
    (["left", "center", "right"] as const).map((placement) => ({
      edge,
      side,
      placement,
    })),
  ),
);

const inside = (inner: PillRect, outer: PillRect) =>
  inner.x >= outer.x &&
  inner.y >= outer.y &&
  inner.x + inner.width <= outer.x + outer.width &&
  inner.y + inner.height <= outer.y + outer.height;

const centreOf = (r: PillRect) => ({
  x: r.x + r.width / 2,
  y: r.y + r.height / 2,
});

describe("where the pill's window rests", () => {
  let cases = 0;
  for (const [name, display] of Object.entries(DISPLAYS)) {
    for (const rest of RESTS) {
      for (const size of SIZES[rest.edge]) {
        it(`${name}: ${rest.edge} (${rest.side} corner, ${rest.placement}), ${size.state}`, () => {
          cases += 1;
          const bounds = pillBounds({ rest, display, ...size });
          // Always whole points, on the display.
          for (const value of Object.values(bounds))
            expect(Number.isInteger(value)).toBe(true);
          expect(inside(bounds, display.bounds)).toBe(true);
          const area = display.workArea;
          if (rest.edge === "top" && display.notch) {
            // Over the menu bar, flush with the top, centred on the notch
            // as far as the display lets it be.
            expect(bounds.y).toBe(display.bounds.y);
            const notchCentre =
              display.bounds.x + display.notch.x + display.notch.width / 2;
            const ideal = notchCentre - bounds.width / 2;
            const clamped = Math.max(
              display.bounds.x,
              Math.min(
                ideal,
                display.bounds.x + display.bounds.width - bounds.width,
              ),
            );
            expect(Math.abs(bounds.x - clamped)).toBeLessThanOrEqual(1);
            return;
          }
          // Everywhere else, inside the work area: never under the menu
          // bar, a Dock or a panel.
          expect(inside(bounds, area)).toBe(true);
          if (rest.edge === "left") {
            expect(bounds.x).toBe(area.x);
            expect(
              Math.abs(centreOf(bounds).y - centreOf(area).y),
            ).toBeLessThanOrEqual(1);
          } else if (rest.edge === "right") {
            expect(bounds.x + bounds.width).toBe(area.x + area.width);
            expect(
              Math.abs(centreOf(bounds).y - centreOf(area).y),
            ).toBeLessThanOrEqual(1);
          } else if (rest.edge === "top") {
            expect(bounds.y).toBe(area.y);
            expect(
              Math.abs(centreOf(bounds).x - centreOf(area).x),
            ).toBeLessThanOrEqual(1);
          } else {
            // The bottom keeps the dock's rule: on the bottom margin (or
            // the top of a work area too short for it).
            expect(bounds.y + bounds.height).toBe(
              Math.max(
                area.y + bounds.height,
                area.y + area.height - PILL_MARGIN,
              ),
            );
            const spot = size.expanded ? rest.placement : rest.side;
            if (spot === "center")
              expect(
                Math.abs(centreOf(bounds).x - centreOf(area).x),
              ).toBeLessThanOrEqual(1);
            else if (spot === "left")
              expect(bounds.x).toBeLessThanOrEqual(area.x + PILL_MARGIN);
            else
              expect(bounds.x + bounds.width).toBeGreaterThanOrEqual(
                area.x + area.width - PILL_MARGIN,
              );
          }
        });
      }
    }
  }
  it("ran the whole matrix", () => {
    // 9 displays × 4 edges × 6 corner/placement pairs × 3 states.
    expect(cases).toBe(9 * 4 * 6 * 3);
  });

  it("rests a bottom pill in the chat region it follows, not the work area", () => {
    const region = rect(260, 80, 900, 700);
    const bounds = pillBounds({
      rest: { edge: "bottom", side: "right", placement: "center" },
      display: DISPLAYS.macbook14,
      region,
      width: 142,
      height: 124,
      expanded: false,
    });
    expect(inside(bounds, region)).toBe(true);
    expect(bounds.x + bounds.width).toBe(region.x + region.width - PILL_MARGIN);
  });

  it("keeps a window larger than its display to the display", () => {
    const bounds = pillBounds({
      rest: { edge: "left", side: "right", placement: "center" },
      display: DISPLAYS.small,
      width: 5000,
      height: 5000,
      expanded: true,
    });
    expect(bounds).toEqual(DISPLAYS.small.workArea);
  });
});

describe("where a dropped pill lands", () => {
  const from: PillRest = { edge: "bottom", side: "right", placement: "center" };
  const still = { x: 0, y: 0 };
  const drop = (
    display: PillDisplay,
    pointer: { x: number; y: number },
    options: {
      velocity?: { x: number; y: number };
      from?: PillRest;
      expanded?: boolean;
    } = {},
  ) =>
    pillLanding({
      displays: Object.values(DISPLAYS).filter(
        // One arrangement: the 14-inch MacBook with its neighbours.
        (candidate) =>
          candidate.id === display.id ||
          [4, 5, 6].includes(candidate.id) ||
          candidate.id === 1,
      ),
      pointer,
      velocity: options.velocity ?? still,
      from: options.from ?? from,
      centre: pointer,
      width: options.expanded ? 600 : 142,
      height: 124,
      expanded: options.expanded ?? false,
    });

  let cases = 0;
  for (const name of [
    "macbook14",
    "externalRightAbove",
    "externalLeft",
    "portraitBelow",
  ] as const) {
    const display: PillDisplay = DISPLAYS[name];
    const area = display.workArea;
    const top = display.notch ? display.bounds.y : area.y;
    // A point 30 points in from each edge, a third and two thirds along it.
    for (const share of [1 / 3, 1 / 2, 2 / 3]) {
      const points: Record<PillEdge, { x: number; y: number }> = {
        bottom: {
          x: area.x + area.width * share,
          y: area.y + area.height - 30,
        },
        top: { x: area.x + area.width * share, y: top + 30 },
        left: { x: area.x + 30, y: area.y + area.height * share },
        right: { x: area.x + area.width - 30, y: area.y + area.height * share },
      };
      for (const edge of PILL_EDGES) {
        it(`${name}: let go near the ${edge} edge (${share.toFixed(2)} along) lands there`, () => {
          cases += 1;
          const point = points[edge];
          const landing = drop(display, point);
          expect(landing?.edge).toBe(edge);
          expect(landing?.displayId).toBe(display.id);
        });
        it(`${name}: thrown from the middle towards the ${edge} edge lands there`, () => {
          cases += 1;
          const middle = centreOf(area);
          const towards = points[edge];
          // Fast enough that 0.15 s carries it most of the way.
          const velocity = {
            x: ((towards.x - middle.x) / 0.15) * 0.95,
            y: ((towards.y - middle.y) / 0.15) * 0.95,
          };
          // The throw is capped at 300 points: only short throws reach.
          const capped =
            Math.abs(velocity.x * 0.15) <= 300 &&
            Math.abs(velocity.y * 0.15) <= 300;
          const landing = drop(display, middle, { velocity });
          if (capped) expect(landing?.edge).toBe(edge);
          else expect(PILL_EDGES).toContain(landing?.edge);
        });
      }
    }
  }
  it("ran the whole drop matrix", () => {
    expect(cases).toBe(4 * 3 * 4 * 2);
  });

  it("takes the menu bar as the top edge on a notched display", () => {
    const landing = drop(DISPLAYS.macbook14, { x: 760, y: 12 });
    expect(landing?.edge).toBe("top");
  });

  it("picks the bottom corner by the 40% rule, and the open strip's placement", () => {
    const display = DISPLAYS.macbook14;
    const y = 940;
    // Folded, from the right corner: the left one only past 40% of the way.
    expect(drop(display, { x: 1100, y })?.side).toBe("right");
    expect(drop(display, { x: 400, y })?.side).toBe("left");
    // Open: three placements.
    const open = (x: number) =>
      drop(display, { x, y }, { expanded: true })?.placement;
    expect(open(200)).toBe("left");
    expect(open(756)).toBe("center");
    expect(open(1300)).toBe("right");
  });

  it("arriving at the bottom from another edge, takes the nearest corner outright", () => {
    const display = DISPLAYS.macbook14;
    const fromLeft: PillRest = {
      edge: "left",
      side: "right",
      placement: "center",
    };
    // 40% hysteresis would keep the right corner; coming from the left
    // edge there is none to keep.
    expect(drop(display, { x: 600, y: 940 }, { from: fromLeft })?.side).toBe(
      "left",
    );
  });

  it("lays the bottom's spots in the chat region a bottom pill follows", () => {
    const region = rect(300, 80, 600, 800);
    const land = (x: number) =>
      pillLanding({
        displays: [DISPLAYS.macbook14],
        pointer: { x, y: 940 },
        velocity: still,
        from,
        centre: { x, y: 940 },
        width: 142,
        height: 124,
        expanded: false,
        bottomArea: region,
      });
    // 400 is past 40% of the way to the region's left corner; 840 is not.
    expect(land(400)?.edge).toBe("bottom");
    expect(land(400)?.side).toBe("left");
    expect(land(840)?.side).toBe("right");
  });

  it("goes to the display under the pointer, or the nearest one off every display", () => {
    expect(drop(DISPLAYS.macbook14, { x: -500, y: 900 })?.displayId).toBe(5);
    expect(drop(DISPLAYS.macbook14, { x: 2000, y: 1100 })?.displayId).toBe(4);
    expect(
      pickDisplay(Object.values(DISPLAYS).slice(0, 1), { x: 9000, y: 9000 })
        ?.id,
    ).toBe(1);
    expect(pickDisplay([], { x: 0, y: 0 })).toBeUndefined();
  });
});

describe("the drop targets", () => {
  for (const [name, display] of Object.entries(DISPLAYS)) {
    for (const expanded of [false, true]) {
      it(`${name}: ${expanded ? "open strip" : "folded pill"} targets lie on the display, one per spot`, () => {
        const targets = pillTargets({
          display,
          rest: { edge: "bottom", side: "right", placement: "center" },
          expanded,
        });
        expect(targets.map((target) => target.key)).toEqual([
          ...(expanded
            ? ["bottom-left", "bottom-center", "bottom-right"]
            : ["bottom-left", "bottom-right"]),
          "left",
          "right",
          "top",
        ]);
        const local = rect(0, 0, display.bounds.width, display.bounds.height);
        for (const target of targets) {
          expect(inside(target.rect, local)).toBe(true);
          expect(pillTargetKey(target.rest, expanded)).toBe(target.key);
        }
        const top = targets.at(-1);
        if (display.notch) {
          // The island wraps the cutout itself.
          expect(top?.notch).toBe(true);
          expect(top?.rect.y).toBe(0);
          expect(top?.rect.height).toBe(display.notch.height);
          expect((top?.rect.x ?? 0) + (top?.rect.width ?? 0) / 2).toBe(
            display.notch.x + display.notch.width / 2,
          );
        } else expect(top?.notch).toBeUndefined();
      });
    }
  }

  it("moves with the arrow keys to the spot that way", () => {
    const targets = pillTargets({
      display: DISPLAYS.macbook14,
      rest: { edge: "bottom", side: "right", placement: "center" },
      expanded: true,
    });
    const toward = (
      from: string,
      direction: "left" | "right" | "up" | "down",
    ) => pillTargetToward(targets, from, direction)?.key;
    expect(toward("bottom-left", "right")).toBe("bottom-center");
    expect(toward("bottom-center", "right")).toBe("bottom-right");
    expect(toward("bottom-center", "up")).toBe("top");
    expect(toward("bottom-left", "up")).toBe("left");
    expect(toward("bottom-right", "up")).toBe("right");
    expect(toward("left", "right")).toBe("right");
    expect(toward("right", "left")).toBe("left");
    expect(toward("top", "down")).toBe("bottom-center");
    expect(toward("left", "down")).toBe("bottom-left");
    // Nothing further that way.
    expect(toward("bottom-left", "left")).toBeUndefined();
    expect(toward("missing", "left")).toBeUndefined();
  });
});

describe("the notch", () => {
  // This MacBook Pro's NSScreen, read through JXA.
  const macbook: NotchReport = {
    id: 1,
    frame: [0, 0, 1512, 982],
    left: [0, 950, 663, 32],
    right: [848, 950, 664, 32],
    top: 32,
  };
  it("comes from the menu bar's areas either side of it", () => {
    expect(notchFromReport(macbook)).toEqual({
      x: 663,
      width: 185,
      height: 32,
    });
  });
  it("is absent where macOS reports no areas, or no safe area (a full-screen Space)", () => {
    const none: [number, number, number, number] = [0, 0, 0, 0];
    expect(notchFromReport({ ...macbook, left: none, right: none })).toBeNull();
    expect(notchFromReport({ ...macbook, top: 0 })).toBeNull();
    expect(
      notchFromReport({
        ...macbook,
        left: [0, 950, 760, 32],
        right: [760, 950, 760, 32],
      }),
    ).toBeNull();
  });
  it("is guessed on a built-in display with a tall menu bar, and only there", () => {
    expect(
      guessNotch({
        internal: true,
        bounds: rect(0, 0, 1512, 982),
        workArea: rect(0, 32, 1512, 950),
      }),
    ).toEqual({ x: 664, width: 185, height: 32 });
    expect(
      guessNotch({
        internal: false,
        bounds: rect(0, 0, 1512, 982),
        workArea: rect(0, 32, 1512, 950),
      }),
    ).toBeNull();
    expect(
      guessNotch({
        internal: true,
        bounds: rect(0, 0, 1440, 900),
        workArea: rect(0, 24, 1440, 876),
      }),
    ).toBeNull();
  });
});

describe("the glide", () => {
  for (const [from, to] of [
    [0, 800],
    [1200, 40],
    [-1900, -12],
    [500, 500],
  ] as const) {
    for (const velocity of [0, 400, -400, 5000]) {
      it(`${from} → ${to} at ${velocity} pt/s starts where it is, lands exactly, and stays near`, () => {
        expect(pillGlide({ from, to, velocity, ms: 0 })).toBeCloseTo(from, 6);
        expect(pillGlide({ from, to, velocity, ms: PILL_GLIDE_MS })).toBe(to);
        const span = Math.abs(to - from);
        // The throw is capped at 800 pt/s: it may carry the pill past its
        // spot only by what that speed adds, never far.
        for (let ms = 0; ms <= PILL_GLIDE_MS; ms += 8) {
          const at = pillGlide({ from, to, velocity, ms });
          expect(at).toBeGreaterThanOrEqual(Math.min(from, to) - 120);
          expect(at).toBeLessThanOrEqual(Math.max(from, to) + 120);
        }
        // Just before landing, within a point.
        expect(
          Math.abs(
            pillGlide({ from, to, velocity, ms: PILL_GLIDE_MS - 1 }) - to,
          ),
        ).toBeLessThanOrEqual(Math.max(1, span / 2000));
      });
    }
  }
  it("without a throw, never overshoots", () => {
    let last = 0;
    for (let ms = 0; ms <= PILL_GLIDE_MS; ms += 4) {
      const at = pillGlide({ from: 0, to: 1000, velocity: 0, ms });
      expect(at).toBeGreaterThanOrEqual(last - 1e-9);
      expect(at).toBeLessThanOrEqual(1000);
      last = at;
    }
  });
});
