import { expect, it } from "vitest";
import { isTextField } from "./text-field.js";

const element = (
  tagName: string,
  attributes: Record<string, string> = {},
  isContentEditable = false,
) => ({
  tagName,
  getAttribute: (name: string) => attributes[name] ?? null,
  isContentEditable,
});

it("counts what takes typing and nothing else", () => {
  expect(isTextField(element("INPUT"))).toBe(true);
  expect(isTextField(element("INPUT", { type: "search" }))).toBe(true);
  expect(isTextField(element("INPUT", { type: "Password" }))).toBe(true);
  expect(isTextField(element("TEXTAREA"))).toBe(true);
  expect(isTextField(element("DIV", {}, true))).toBe(true);
  expect(isTextField(element("INPUT", { type: "checkbox" }))).toBe(false);
  expect(isTextField(element("BUTTON"))).toBe(false);
  expect(isTextField(element("P"))).toBe(false);
  expect(isTextField(null)).toBe(false);
});
