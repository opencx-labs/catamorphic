import { describe, expect, it } from "vitest";
import { shouldShowWindow } from "./e2e-window-mode.js";

describe("shouldShowWindow", () => {
  it("always shows normal desktop windows", () => {
    expect(
      shouldShowWindow({
        e2eDataDir: undefined,
        e2eWindowMode: "hidden",
      }),
    ).toBe(true);
  });

  it("keeps the default E2E window hidden", () => {
    expect(
      shouldShowWindow({
        e2eDataDir: "/tmp/catamorphic-e2e",
        e2eWindowMode: undefined,
      }),
    ).toBe(false);
  });

  it("shows E2E windows in visible realism mode", () => {
    expect(
      shouldShowWindow({
        e2eDataDir: "/tmp/catamorphic-e2e",
        e2eWindowMode: "visible",
      }),
    ).toBe(true);
  });
});
