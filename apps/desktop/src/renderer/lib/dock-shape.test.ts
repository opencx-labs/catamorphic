import { expect, it } from "vitest";
import { shadowReach } from "./dock-shape.js";

it("reaches as far as a shadow visibly draws, offset included", () => {
  // Tailwind's shadow-2xl as Chromium computes it.
  expect(shadowReach("rgba(0, 0, 0, 0.25) 0px 25px 50px -12px")).toEqual({
    left: 13,
    right: 13,
    top: 0,
    bottom: 38,
  });
});

it("takes the widest of several shadows and skips inset ones", () => {
  expect(
    shadowReach(
      "rgb(0 0 0 / 0.1) 0px 10px 15px -3px, rgb(0, 0, 0) 0px 0px 0px 1px, rgba(0, 0, 0, 0.5) 0px 0px 40px 0px inset",
    ),
  ).toEqual({ left: 4.5, right: 4.5, top: 1, bottom: 14.5 });
});

it("draws nothing outside for no shadow", () => {
  expect(shadowReach("none")).toEqual({
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
  });
});
