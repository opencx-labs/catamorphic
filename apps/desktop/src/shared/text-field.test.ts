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

const press = (
  key: string,
  modifiers: { metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean } = {},
) => ({
  key,
  metaKey: modifiers.metaKey ?? false,
  ctrlKey: modifiers.ctrlKey ?? false,
  altKey: modifiers.altKey ?? false,
});

it("keeps the caret keys for a field, whatever they are bound to", () => {
  const field = element("INPUT");
  const keeps = (event: ReturnType<typeof press>, mac: boolean) =>
    fieldKeepsKey({ event, focused: field, mac });
  expect(keeps(press("ArrowLeft", { metaKey: true }), true)).toBe(true);
  expect(keeps(press("ArrowLeft", { altKey: true }), true)).toBe(true);
  expect(keeps(press("End"), true)).toBe(true);
  expect(keeps(press("ArrowLeft", { ctrlKey: true }), false)).toBe(true);
  expect(keeps(press("Home"), false)).toBe(true);
  expect(keeps(press("[", { metaKey: true }), true)).toBe(false);
  expect(
    fieldKeepsKey({
      event: press("ArrowLeft", { metaKey: true }),
      focused: element("BODY"),
      mac: true,
    }),
  ).toBe(false);
});

it("leaves a caret key with modifiers no caret moves by to its binding", () => {
  const field = element("INPUT");
  const keeps = (event: ReturnType<typeof press>, mac: boolean) =>
    fieldKeepsKey({ event, focused: field, mac });
  expect(keeps(press("ArrowLeft", { metaKey: true, altKey: true }), true)).toBe(
    false,
  );
  expect(keeps(press("ArrowLeft", { ctrlKey: true }), true)).toBe(false);
  expect(keeps(press("ArrowLeft", { altKey: true }), false)).toBe(false);
  expect(keeps(press("ArrowLeft", { metaKey: true }), false)).toBe(false);
});
