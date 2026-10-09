import { expect, it } from "vitest";
import { fieldKeepsKey, isTextField } from "./text-field.js";

interface FakeElement {
  tagName: string;
  getAttribute: (name: string) => string | null;
  isContentEditable: boolean;
  shadowRoot: { activeElement: FakeElement | null } | null;
}

const element = (
  tagName: string,
  attributes: Record<string, string> = {},
  isContentEditable = false,
  shadowFocus: FakeElement | null = null,
): FakeElement => ({
  tagName,
  getAttribute: (name: string) => attributes[name] ?? null,
  isContentEditable,
  shadowRoot: shadowFocus ? { activeElement: shadowFocus } : null,
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

it("looks into a shadow root for the field that has focus", () => {
  const search = element("SEARCH-BOX", {}, false, element("INPUT"));
  expect(isTextField(search)).toBe(true);
  expect(isTextField(element("SEARCH-BOX", {}, false, element("BUTTON")))).toBe(
    false,
  );
});

it("keeps the caret keys for a field, whatever they are bound to", () => {
  const field = element("INPUT");
  expect(fieldKeepsKey({ key: "ArrowLeft", focused: field })).toBe(true);
  expect(fieldKeepsKey({ key: "End", focused: field })).toBe(true);
  expect(fieldKeepsKey({ key: "[", focused: field })).toBe(false);
  expect(fieldKeepsKey({ key: "ArrowLeft", focused: element("BODY") })).toBe(
    false,
  );
});
