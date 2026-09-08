import { describe, expect, it } from "vitest";
import { DEFAULT_KEYBINDINGS } from "../shared/actions.js";
import {
  bindingFromEvent,
  matchesShortcut,
  type ShortcutEvent,
} from "../shared/keybindings.js";
import {
  isValidBinding,
  normalizeKeybindings,
  toAccelerator,
} from "./keybindings.js";

const event: ShortcutEvent = {
  key: "b",
  code: "KeyB",
  metaKey: true,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
};

describe("custom shortcuts", () => {
  it("accepts every shipped default, including punctuation", () => {
    for (const binding of Object.values(DEFAULT_KEYBINDINGS)) {
      expect(isValidBinding(binding), binding).toBe(true);
    }
    expect(
      normalizeKeybindings({ "toggle-sidebar": "Cmd+;" })["toggle-sidebar"],
    ).toBe("Cmd+;");
  });

  it("preserves disabled shortcuts and rejects malformed modifiers", () => {
    expect(
      normalizeKeybindings({ "toggle-sidebar": "" })["toggle-sidebar"],
    ).toBe("");
    expect(matchesShortcut({ event, binding: "", mac: true })).toBe(false);
    for (const binding of ["Cmd+Cmd+B", "Cmd+", "Hyper+B", "Cmd+not-a-key"]) {
      expect(isValidBinding(binding)).toBe(false);
    }
  });

  it("uses the platform command key consistently with native menus", () => {
    expect(matchesShortcut({ event, binding: "Cmd+B", mac: true })).toBe(true);
    expect(
      matchesShortcut({
        event: { ...event, metaKey: false, ctrlKey: true },
        binding: "Cmd+B",
        mac: false,
      }),
    ).toBe(true);
    expect(
      matchesShortcut({
        event: { ...event, metaKey: false, ctrlKey: true },
        binding: "Cmd+B",
        mac: true,
      }),
    ).toBe(false);
    expect(toAccelerator("Cmd+ArrowLeft")).toBe("CmdOrCtrl+Left");
    expect(toAccelerator("")).toBeUndefined();
  });

  it("records Option-letter and shifted punctuation shortcuts", () => {
    const option = { ...event, key: "¬", code: "KeyL", altKey: true };
    expect(bindingFromEvent(option)).toBe("Cmd+Alt+L");
    expect(
      matchesShortcut({ event: option, binding: "Cmd+Alt+L", mac: true }),
    ).toBe(true);
    expect(
      matchesShortcut({
        event: { ...event, key: "{", code: "BracketLeft", shiftKey: true },
        binding: "Cmd+Shift+[",
        mac: true,
      }),
    ).toBe(true);
    expect(
      bindingFromEvent({ ...event, key: "+", code: "Equal", shiftKey: true }),
    ).toBe("Cmd+Shift+Plus");
    expect(isValidBinding("Cmd++")).toBe(true);
  });
});
