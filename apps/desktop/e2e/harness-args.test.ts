import { describe, expect, it } from "vitest";
import { electronLaunchArgs } from "./harness-args.js";

describe("electronLaunchArgs", () => {
  it("configures headless-safe Chromium services only on Linux CI runners", () => {
    expect(
      electronLaunchArgs({ cdpPort: 9342, ci: "true", platform: "linux" }),
    ).toEqual([
      ".",
      "--remote-debugging-port=9342",
      "--no-sandbox",
      "--password-store=basic",
    ]);
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
