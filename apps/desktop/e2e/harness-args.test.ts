import { describe, expect, it } from "vitest";
import { electronLaunchArgs } from "./harness-args.js";

describe("electronLaunchArgs", () => {
  it("isolates fake credentials from the macOS Keychain", () => {
    expect(
      electronLaunchArgs({
        cdpPort: 9342,
        ci: undefined,
        platform: "darwin",
        useMockKeychain: true,
      }),
    ).toContain("--use-mock-keychain");
    expect(
      electronLaunchArgs({
        cdpPort: 9342,
        ci: undefined,
        platform: "darwin",
        useMockKeychain: false,
      }),
    ).not.toContain("--use-mock-keychain");
  });
  it("disables Chromium's SUID sandbox only on Linux CI runners", () => {
    expect(
      electronLaunchArgs({ cdpPort: 9342, ci: "true", platform: "linux" }),
    ).toEqual([".", "--remote-debugging-port=9342", "--no-sandbox"]);
  });

  it("preserves the normal Electron sandbox outside Linux CI", () => {
    expect(
      electronLaunchArgs({ cdpPort: 9342, ci: undefined, platform: "linux" }),
    ).toEqual([".", "--remote-debugging-port=9342"]);
    expect(
      electronLaunchArgs({ cdpPort: 9342, ci: "true", platform: "darwin" }),
    ).toEqual([".", "--remote-debugging-port=9342"]);
  });
});
