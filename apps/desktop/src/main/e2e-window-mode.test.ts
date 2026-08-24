import { describe, expect, it } from "vitest";
import {
  shouldShowWindow,
  shouldUseE2ePlainTextEncryption,
} from "./e2e-window-mode.js";

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

describe("shouldUseE2ePlainTextEncryption", () => {
  it("enables the Electron fallback only for isolated Linux E2E profiles", () => {
    expect(
      shouldUseE2ePlainTextEncryption({
        e2eDataDir: "/tmp/catamorphic-e2e",
        platform: "linux",
      }),
    ).toBe(true);
    expect(
      shouldUseE2ePlainTextEncryption({
        e2eDataDir: undefined,
        platform: "linux",
      }),
    ).toBe(false);
    expect(
      shouldUseE2ePlainTextEncryption({
        e2eDataDir: "/tmp/catamorphic-e2e",
        platform: "darwin",
      }),
    ).toBe(false);
  });
});
