import { describe, expect, it } from "vitest";
import { CASCADE_STEP, cascadeWindowState } from "./window-state.js";

const workArea = { x: 0, y: 25, width: 1440, height: 875 };

describe("cascadeWindowState", () => {
  it("opens a step down and to the right, at the same size", () => {
    expect(
      cascadeWindowState({ x: 100, y: 80, width: 1000, height: 700 }, workArea),
    ).toEqual({
      x: 100 + CASCADE_STEP,
      y: 80 + CASCADE_STEP,
      width: 1000,
      height: 700,
      maximized: false,
      fullscreen: false,
    });
  });

  it("starts again from the work area's corner when a step would leave it", () => {
    expect(
      cascadeWindowState({ x: 0, y: 25, width: 1440, height: 875 }, workArea),
    ).toMatchObject({ x: 0, y: 25, width: 1440, height: 875 });
    expect(
      cascadeWindowState(
        { x: 400, y: 200, width: 1000, height: 600 },
        workArea,
      ),
    ).toMatchObject({ x: 424, y: 224 });
    expect(
      cascadeWindowState(
        { x: 430, y: 200, width: 1000, height: 600 },
        workArea,
      ),
    ).toMatchObject({ x: 0, y: 25 });
  });

  it("never opens larger than the work area", () => {
    expect(
      cascadeWindowState({ x: 0, y: 0, width: 3000, height: 2000 }, workArea),
    ).toMatchObject({ width: 1440, height: 875 });
  });
});
