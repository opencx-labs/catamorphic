// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { installFocusModality } from "./focus-modality.js";

let uninstall: (() => void) | undefined;
afterEach(() => uninstall?.());

const modality = () => document.documentElement.dataset.focusModality;
const key = (name: string) =>
  document.body.dispatchEvent(
    new KeyboardEvent("keydown", { key: name, bubbles: true }),
  );
const press = () =>
  document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));

describe("focus modality", () => {
  it("leaves Chromium's heuristic alone until an input leads", () => {
    uninstall = installFocusModality();
    expect(modality()).toBeUndefined();
  });

  it("a pointer press hides rings and a navigation key brings them back", () => {
    uninstall = installFocusModality();
    press();
    expect(modality()).toBe("pointer");
    key("Tab");
    expect(modality()).toBe("keyboard");
    press();
    key("ArrowDown");
    expect(modality()).toBe("keyboard");
  });

  it("Escape, Enter and typing keep the input that led", () => {
    uninstall = installFocusModality();
    press();
    for (const name of ["Escape", "Enter", "a", "Meta"]) key(name);
    expect(modality()).toBe("pointer");
    key("Tab");
    key("Escape");
    expect(modality()).toBe("keyboard");
  });

  it("uninstalling clears the marker", () => {
    uninstall = installFocusModality();
    press();
    uninstall();
    uninstall = undefined;
    expect(modality()).toBeUndefined();
    press();
    expect(modality()).toBeUndefined();
  });
});
