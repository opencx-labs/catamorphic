import type { ResolvedTheme } from "./desktop-api.js";

/** `color` at `percent` opacity, as the app's own selection mixes it. */
const tint = (color: string, percent: number) =>
  `color-mix(in srgb, ${color} ${percent}%, transparent)`;

/**
 * What a web page borrows from the theme, injected into every page's
 * document: selected text and find-in-page matches take the accent, as
 * the app's own selection does, instead of the system highlight and
 * Chromium's yellow and orange. Injected ahead of the page's own styles
 * (preload/webview.ts) and in a cascade layer of its own, the first and so
 * the weakest, so a page that styles its selection keeps it, from a layer
 * (Tailwind's utilities) or not. Chromium paints its find results through
 * `::search-text`.
 * Theme colors are validated CSS colors (main/theme.ts), so they cannot
 * leave their declaration.
 */
export function pageThemeCss(theme: ResolvedTheme): string {
  const { accent, "accent-fg": accentFg } = theme.colors;
  return [
    "@layer {",
    `  ::selection { background-color: ${tint(accent, 30)}; }`,
    `  ::search-text { background-color: ${tint(accent, 35)}; color: inherit; }`,
    `  ::search-text:current { background-color: ${accent}; color: ${accentFg}; }`,
    "}",
  ].join("\n");
}
