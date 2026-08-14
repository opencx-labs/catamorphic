import { describe, expect, it } from "vitest";
import { APP_BASE_CSS, appThemeCss, appThemeVars } from "../theme.js";

describe("appThemeCss", () => {
  it("emits every provided feel token as its CSS var", () => {
    const css = appThemeCss({
      appearance: "light",
      colors: { bg: "#fff" },
      fonts: { sans: "Georgia,serif", mono: "Menlo,monospace" },
      radii: { sm: "2px", md: "3px", lg: "5px" },
      easing: "cubic-bezier(0.4,0,0.2,1)",
      baseFontSize: "15px",
      rowHeight: "36px",
      motion: { fast: "80ms", base: "120ms", slow: "160ms" },
    });
    expect(css).toContain("--color-bg:#fff;");
    expect(css).toContain("--font-sans:Georgia,serif;");
    expect(css).toContain("--font-mono:Menlo,monospace;");
    expect(css).toContain("--radius-sm:2px;");
    expect(css).toContain("--radius-md:3px;");
    expect(css).toContain("--radius-lg:5px;");
    expect(css).toContain("--ease-standard:cubic-bezier(0.4,0,0.2,1);");
    expect(css).toContain("--cat-font-size:15px;");
    expect(css).toContain("--cat-row-h:36px;");
    expect(css).toContain("--cat-motion-fast:80ms;");
    expect(css).toContain("--cat-motion-base:120ms;");
    expect(css).toContain("--cat-motion-slow:160ms;");
    expect(css).toContain("color-scheme:light");
  });

  it("emits nothing for omitted tokens, leaving neutral defaults in force", () => {
    const css = appThemeCss({ appearance: "dark", colors: { accent: "#f00" } });
    expect(css).toBe(":root{--color-accent:#f00;color-scheme:dark}");
    expect(appThemeVars({ appearance: "dark", colors: {} })).toEqual([]);
  });

  it("has a neutral default in the base layer for every feel var", () => {
    // Every var a theme can pin must default in APP_BASE_CSS, so an
    // unthemed mount still resolves the whole vocabulary.
    const vars = appThemeVars({
      appearance: "dark",
      colors: {},
      fonts: { sans: "x", mono: "x" },
      radii: { sm: "x", md: "x", lg: "x" },
      easing: "x",
      baseFontSize: "x",
      rowHeight: "x",
      motion: { fast: "x", base: "x", slow: "x" },
    });
    for (const [name] of vars) {
      expect(APP_BASE_CSS).toContain(`${name}:`);
    }
  });
});
