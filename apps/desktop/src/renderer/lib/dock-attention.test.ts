import { describe, expect, it } from "vitest";
import { focusMovedByPerson, pointerLeft } from "./dock-attention.js";

const box = { left: 100, top: 100, right: 500, bottom: 400 };

describe("pointerLeft", () => {
  it("is a real leave when the pointer moved out just now", () => {
    expect(
      pointerLeft({ clientX: 600, clientY: 200, box, msSinceMove: 10 }),
    ).toBe(true);
  });
  it("ignores a leave while the pointer is still inside the box", () => {
    expect(
      pointerLeft({ clientX: 300, clientY: 200, box, msSinceMove: 10 }),
    ).toBe(false);
  });
  it("ignores a leave the layout caused under a parked pointer", () => {
    expect(
      pointerLeft({ clientX: 600, clientY: 200, box, msSinceMove: 5_000 }),
    ).toBe(false);
  });
  it("trusts a recent leave when the box cannot be measured", () => {
    expect(
      pointerLeft({ clientX: 600, clientY: 200, box: null, msSinceMove: 10 }),
    ).toBe(true);
  });
});

describe("focusMovedByPerson", () => {
  it("counts focus that follows a click or key", () => {
    expect(focusMovedByPerson(50)).toBe(true);
  });
  it("ignores focus nothing preceded", () => {
    expect(focusMovedByPerson(3_000)).toBe(false);
  });
});
