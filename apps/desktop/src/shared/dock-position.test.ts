import { expect, it } from "vitest";
import { dockLanding, dockPosition } from "./dock-position.js";

it("snaps against the active display, including displays with negative coordinates", () => {
  const input = {
    area: { x: -1920, y: 40, width: 1920, height: 1040 },
    width: 100,
    height: 76,
  };
  expect(dockPosition({ ...input, side: "left", centered: false })).toEqual({
    x: -1908,
    y: 992,
  });
  expect(dockPosition({ ...input, side: "right", centered: false })).toEqual({
    x: -112,
    y: 992,
  });
  expect(
    dockPosition({
      ...input,
      width: 780,
      height: 560,
      side: "right",
      centered: true,
    }),
  ).toEqual({ x: -1350, y: 508 });
});

it("lands a dragged strip on the nearest spot, leaving its own after 40% of the way", () => {
  const spots = [
    { spot: "left", at: 100 },
    { spot: "center", at: 800 },
    { spot: "right", at: 1500 },
  ] as const;
  // From the left, 40% of the way to the centre is 380.
  expect(dockLanding({ from: "left", centre: 370, spots })).toBe("left");
  expect(dockLanding({ from: "left", centre: 390, spots })).toBe("center");
  // From the right, the same share of its way.
  expect(dockLanding({ from: "right", centre: 1230, spots })).toBe("right");
  expect(dockLanding({ from: "right", centre: 1210, spots })).toBe("center");
  // A strip let go near where it started goes back there.
  expect(dockLanding({ from: "center", centre: 640, spots })).toBe("center");
  // Corners only, for the collapsed bubble: 40% of 1400 from the right.
  const corners = [
    { spot: "left", at: 100 },
    { spot: "right", at: 1500 },
  ] as const;
  expect(dockLanding({ from: "right", centre: 950, spots: corners })).toBe(
    "right",
  );
  expect(dockLanding({ from: "right", centre: 930, spots: corners })).toBe(
    "left",
  );
});
