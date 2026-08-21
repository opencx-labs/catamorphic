import { describe, expect, it } from "vitest";
import { normalizeTheme, resolveTheme } from "./theme.js";

describe("theme", () => {
  it("mirrors the desktop resolution: preset + overrides, derived appearance", () => {
    const resolved = resolveTheme(
      normalizeTheme({ preset: "midnight", overrides: { accent: "#ff0000" } }),
    );
    expect(resolved.preset).toBe("midnight");
    expect(resolved.colors.accent).toBe("#ff0000");
    expect(resolved.appearance).toBe("dark");
  });

  it("appearance follows the actual background", () => {
    const resolved = resolveTheme(
      normalizeTheme({ preset: "dark", overrides: { bg: "#ffffff" } }),
    );
    expect(resolved.appearance).toBe("light");
  });

  it("drops unknown presets and invalid colors", () => {
    const config = normalizeTheme({
      preset: "neon-vaporwave",
      overrides: { accent: "url(javascript:alert(1))", fg: "#123456" },
    });
    expect(config.preset).toBe("dark");
    expect(config.overrides).toEqual({ fg: "#123456" });
  });
});
