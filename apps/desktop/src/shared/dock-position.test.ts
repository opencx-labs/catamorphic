import { expect, it } from "vitest";
import { dockPosition } from "./dock-position.js";

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
