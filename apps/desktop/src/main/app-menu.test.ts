import { describe, expect, it, vi } from "vitest";
import { macApplicationMenu } from "./app-menu.js";

describe("macOS application menu", () => {
  it("offers update checking beside About without losing native app actions", () => {
    const checkForUpdates = vi.fn();
    const menu = macApplicationMenu({
      appName: "Catamorphic",
      checkForUpdates,
    });
    expect(menu.label).toBe("Catamorphic");
    const check = menu.submenu.find(
      (item) => item.label === "Check for Updates…",
    );
    check?.click?.();
    expect(checkForUpdates).toHaveBeenCalledOnce();
    expect(menu.submenu.map((item) => item.role).filter(Boolean)).toEqual([
      "about",
      "services",
      "hide",
      "hideOthers",
      "unhide",
      "quit",
    ]);
  });
});
