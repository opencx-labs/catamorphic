/**
 * The design-token vocabulary shared by the host shell and mounted apps.
 *
 * The host injects the CURRENT theme (its resolved token values) into every
 * app's guest document as `--color-*` custom properties and keeps them live
 * over postMessage, so an app styled with these variables matches the shell
 * pixel-for-pixel and follows theme switches without a rebuild. This module
 * is the single definition of that vocabulary: the mount, the guest
 * document, and the agent-facing skill docs all derive from it.
 */

/** Color tokens, in the order they read best in docs. */
export const APP_THEME_COLOR_TOKENS = [
  "bg",
  "bg-raised",
  "bg-overlay",
  "bg-inset",
  "border",
  "border-strong",
  "fg",
  "fg-muted",
  "fg-faint",
  "accent",
  "accent-fg",
  "success",
  "warning",
  "danger",
  "info",
] as const;

export type AppThemeColorToken = (typeof APP_THEME_COLOR_TOKENS)[number];

/** The theme snapshot a host hands to a mounted app. */
export interface AppHostTheme {
  appearance: "dark" | "light";
  colors: Partial<Record<AppThemeColorToken, string>>;
}

/** `:root` rule carrying the host theme into a guest document. */
export function appThemeCss(theme: AppHostTheme): string {
  const vars = APP_THEME_COLOR_TOKENS.filter(
    (token) => theme.colors[token] !== undefined,
  )
    .map((token) => `--color-${token}:${theme.colors[token]};`)
    .join("");
  return `:root{${vars}color-scheme:${theme.appearance}}`;
}

/**
 * Base layer for every guest document, injected before the app's own CSS
 * (which can therefore override any of it). Mirrors the shell's primitives —
 * font stacks, radii, the one easing — so an app that just writes
 * `var(--font-sans)` / `var(--radius-lg)` / `var(--ease-standard)` lands on
 * the shell's exact values. The font stacks resolve through the OS, so no
 * font files cross the CSP.
 */
export const APP_BASE_CSS = [
  ":root{",
  '--font-sans:"Inter",system-ui,-apple-system,sans-serif;',
  '--font-mono:"JetBrains Mono",ui-monospace,"SF Mono",monospace;',
  "--radius-sm:4px;--radius-md:6px;--radius-lg:10px;",
  "--ease-standard:cubic-bezier(0.2,0,0,1)",
  "}",
  "*{box-sizing:border-box}",
  // Fallbacks are the shell's dark defaults, for hosts that mount without
  // a theme; themed hosts always override via appThemeCss.
  "body{margin:0;background:var(--color-bg,#0a0a0b);color:var(--color-fg,#e6e6e9);",
  "font-family:var(--font-sans);font-size:13px;-webkit-font-smoothing:antialiased}",
].join("");
