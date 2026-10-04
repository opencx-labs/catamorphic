// @vitest-environment jsdom
import { expect, it } from "vitest";
import {
  appIsMovingFocus,
  moveFocusAsApp,
  notePersonInput,
  personInputCount,
  personMovedOn,
} from "./app-focus.js";

it("marks the app's own focus moves and counts the person's input", () => {
  const input = document.createElement("input");
  document.body.append(input);
  const seen: boolean[] = [];
  window.addEventListener("focusin", () => seen.push(appIsMovingFocus()));
  moveFocusAsApp(() => input.focus());
  input.blur();
  input.focus();
  expect(seen).toEqual([true, false]);
  expect(appIsMovingFocus()).toBe(false);

  const before = personInputCount();
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "n" }));
  window.dispatchEvent(new Event("pointerdown"));
  notePersonInput();
  expect(personInputCount()).toBe(before + 3);
  input.remove();
});

it("treats the person as moved on only once they acted and focus is somewhere", () => {
  const asked = personInputCount();
  const composer = document.createElement("textarea");
  document.body.append(composer);
  expect(personMovedOn(asked)).toBe(false);
  // Typing with nothing focused (a New Tab still arriving) is not moving on.
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "g" }));
  expect(personMovedOn(asked)).toBe(false);
  // A chat opened and took focus: the arriving tab leaves it there.
  composer.focus();
  expect(personMovedOn(asked)).toBe(true);
  composer.remove();
});
