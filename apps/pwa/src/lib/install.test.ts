import { describe, expect, it } from "vitest";
import { installPromotionKind } from "./install.js";

const browser = {
  secureContext: true,
  standalone: false,
  dismissed: false,
  hasNativePrompt: false,
  userAgent: "Mozilla/5.0 Chrome/140 Mobile",
  platform: "Linux armv8l",
  maxTouchPoints: 5,
};

describe("installPromotionKind", () => {
  it("never promotes again after the user dismisses it", () => {
    expect(
      installPromotionKind({
        ...browser,
        dismissed: true,
        hasNativePrompt: true,
      }),
    ).toBeNull();
  });

  it("does not promise installation on an insecure LAN origin", () => {
    expect(
      installPromotionKind({
        ...browser,
        secureContext: false,
        hasNativePrompt: true,
      }),
    ).toBeNull();
  });

  it("uses the browser prompt when one is available", () => {
    expect(installPromotionKind({ ...browser, hasNativePrompt: true })).toBe(
      "native",
    );
  });

  it("offers manual Safari instructions on iPhone and iPad", () => {
    expect(
      installPromotionKind({
        ...browser,
        userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X)",
        platform: "iPhone",
      }),
    ).toBe("ios");
    expect(
      installPromotionKind({
        ...browser,
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)",
        platform: "MacIntel",
        maxTouchPoints: 5,
      }),
    ).toBe("ios");
  });
});
