import { describe, expect, it, vi } from "vitest";
import { sidebarPointerZone } from "./window-sidebar-edge.js";

vi.mock("electron", () => ({ screen: {} }));

describe("native sidebar edge detection", () => {
  const windowBounds = { x: -1200, y: 40, width: 1000, height: 700 };
  const contentBounds = { x: -1192, y: 70, width: 984, height: 662 };
  const zone = (x: number, y: number) =>
    sidebarPointerZone({ cursor: { x, y }, windowBounds, contentBounds });

  it("includes the native resize edge on displays with negative coordinates", () => {
    expect(zone(-1200, 400)).toBe("edge");
    expect(zone(-1195, 400)).toBe("edge");
    expect(zone(-1181, 400)).toBe("edge");
    expect(zone(-1180, 400)).toBe("inside");
  });

  it("reveals along the whole content edge, without reacting to other windows", () => {
    expect(zone(-1190, 70)).toBe("edge");
    expect(zone(-1190, 731)).toBe("edge");
    expect(zone(-1201, 400)).toBe("outside");
    expect(zone(-1190, 69)).toBe("outside");
    expect(zone(-1190, 732)).toBe("outside");
  });

  it("keeps the pointer inside the overlay until it returns to the page", () => {
    expect(zone(-1192 + 259, 400)).toBe("inside");
    expect(zone(-1192 + 260, 400)).toBe("outside");
    expect(zone(-200, 400)).toBe("outside");
  });
});
