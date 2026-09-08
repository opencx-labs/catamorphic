import { describe, expect, it } from "vitest";
import { DEFAULT_KEYBINDINGS } from "../shared/actions.js";
import { openModeFromEvent } from "../shared/open-mode.js";

const plain = {
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
};
describe("resource opening", () => {
  for (const mac of [true, false]) {
    it(`uses the same mouse and keyboard modifiers on ${mac ? "macOS" : "Windows/Linux"}`, () => {
      const primary = mac ? { metaKey: true } : { ctrlKey: true };
      expect(openModeFromEvent(plain, "replace", mac)).toBe("replace");
      expect(openModeFromEvent({ ...plain, ...primary }, "replace", mac)).toBe(
        "tab",
      );
      expect(
        openModeFromEvent(
          { ...plain, ...primary, shiftKey: true },
          "replace",
          mac,
        ),
      ).toBe("side");
      expect(
        openModeFromEvent({ ...plain, altKey: true }, "replace", mac),
      ).toBe("floating");
      expect(openModeFromEvent(plain, "side", mac)).toBe("side");
      expect(
        openModeFromEvent(
          { ...plain, ...primary, altKey: true },
          "replace",
          mac,
        ),
      ).toBe("tab");
    });
  }
  it("has no float-current shortcut to remap or advertise", () => {
    expect(DEFAULT_KEYBINDINGS).not.toHaveProperty("float-current-tab");
  });
});
