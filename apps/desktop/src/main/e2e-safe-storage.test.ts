import { describe, expect, it } from "vitest";
import { shouldUseE2ePlainTextEncryption } from "./e2e-safe-storage.js";

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
