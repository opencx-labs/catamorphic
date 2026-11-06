import { expect, it } from "vitest";
import { resolveTheme } from "../../main/theme.js";
import { pageThemeCss } from "./page-theme.js";

it("gives pages the theme's accent for selection and find matches", () => {
  const css = pageThemeCss(
    resolveTheme({
      selection: "light",
      overrides: { accent: "oklch(0.6 0.2 250)", "accent-fg": "#fafafa" },
    }),
  );
  expect(css).toContain(
    "::selection { background-color: color-mix(in srgb, oklch(0.6 0.2 250) 30%, transparent); }",
  );
  expect(css).toContain(
    "::search-text { background-color: color-mix(in srgb, oklch(0.6 0.2 250) 35%, transparent); color: inherit; }",
  );
  expect(css).toContain(
    "::search-text:current { background-color: oklch(0.6 0.2 250); color: #fafafa; }",
  );
});
