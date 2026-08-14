/**
 * The design-token vocabulary shared by an embedding host and mounted apps.
 *
 * The host injects the CURRENT theme (its resolved token values) into every
 * app's guest document as CSS custom properties and keeps them live over
 * postMessage, so an app styled with these variables matches the embedding
 * shell pixel-for-pixel and follows theme switches without a rebuild. This
 * module is the single definition of that vocabulary: the mount, the guest
 * document, and the agent-facing skill docs all derive from it.
 *
 * The contract covers the app's whole FEEL, not just color. The kit ships
 * structure and behavior; every aesthetic decision flows from these tokens,
 * with neutral defaults in {@link APP_BASE_CSS} for hosts that mount without
 * a theme:
 *
 * - `--color-*` — the color tokens ({@link APP_THEME_COLOR_TOKENS}).
 * - `--font-sans` / `--font-mono` — the host's font stacks.
 * - `--radius-sm/md/lg` — corner radii.
 * - `--ease-standard` — the host's one standard easing curve.
 * - `--cat-font-size` — base type size; every kit size derives from it
 *   (or from `--cat-font-size-sm`, the small-label size for badges, hints,
 *   and table headers — not part of {@link AppHostTheme}; embedders that
 *   want a different small size set the var via their own stylesheet).
 * - `--cat-row-h` — list/table/control row height, the density knob.
 * - `--cat-motion-fast/base/slow` — motion durations: hover/color feedback,
 *   structural enters (dialogs, popovers), and large-surface moves.
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

/**
 * The theme snapshot a host hands to a mounted app. Everything beyond
 * `appearance` + `colors` is optional feel: an omitted token leaves the
 * neutral default from {@link APP_BASE_CSS} in place.
 */
export interface AppHostTheme {
  appearance: "dark" | "light";
  colors: Partial<Record<AppThemeColorToken, string>>;
  /** Host font stacks (`--font-sans` / `--font-mono`). */
  fonts?: { sans?: string; mono?: string };
  /** Corner radii (`--radius-sm/md/lg`). */
  radii?: { sm?: string; md?: string; lg?: string };
  /** The host's standard easing curve (`--ease-standard`). */
  easing?: string;
  /** Base type size (`--cat-font-size`), e.g. `"13px"`. */
  baseFontSize?: string;
  /** List/table/control row height (`--cat-row-h`), e.g. `"28px"`. */
  rowHeight?: string;
  /**
   * Motion durations (`--cat-motion-fast/base/slow`): ~hover feedback,
   * structural enters, large-surface moves.
   */
  motion?: { fast?: string; base?: string; slow?: string };
}

/**
 * Every (custom property, value) pair a theme snapshot pins — colors and
 * feel alike. One flattening shared by the initial `:root` rule and the
 * live-theme handler in the guest runtime.
 */
export function appThemeVars(theme: AppHostTheme): [string, string][] {
  const vars: [string, string][] = [];
  for (const token of APP_THEME_COLOR_TOKENS) {
    const value = theme.colors[token];
    if (value !== undefined) vars.push([`--color-${token}`, value]);
  }
  const feel: [string, string | undefined][] = [
    ["--font-sans", theme.fonts?.sans],
    ["--font-mono", theme.fonts?.mono],
    ["--radius-sm", theme.radii?.sm],
    ["--radius-md", theme.radii?.md],
    ["--radius-lg", theme.radii?.lg],
    ["--ease-standard", theme.easing],
    ["--cat-font-size", theme.baseFontSize],
    ["--cat-row-h", theme.rowHeight],
    ["--cat-motion-fast", theme.motion?.fast],
    ["--cat-motion-base", theme.motion?.base],
    ["--cat-motion-slow", theme.motion?.slow],
  ];
  for (const [name, value] of feel) {
    if (value !== undefined) vars.push([name, value]);
  }
  return vars;
}

/** `:root` rule carrying the host theme into a guest document. */
export function appThemeCss(theme: AppHostTheme): string {
  const vars = appThemeVars(theme)
    .map(([name, value]) => `${name}:${value};`)
    .join("");
  return `:root{${vars}color-scheme:${theme.appearance}}`;
}

/**
 * Base layer for every guest document, injected before the theme rule (which
 * therefore overrides any of it) and before the app's own CSS. The values are
 * deliberately NEUTRAL — plain OS font stacks, unopinionated radii/motion —
 * so an app mounted by a host that supplies no theme looks native to nothing
 * in particular; a themed host overrides everything via {@link appThemeCss}.
 * The font stacks resolve through the OS, so no font files cross the CSP.
 */
export const APP_BASE_CSS = [
  ":root{",
  "--font-sans:system-ui,-apple-system,sans-serif;",
  "--font-mono:ui-monospace,monospace;",
  "--radius-sm:4px;--radius-md:6px;--radius-lg:10px;",
  "--ease-standard:cubic-bezier(0.2,0,0,1);",
  "--cat-font-size:13px;--cat-font-size-sm:11px;",
  "--cat-row-h:28px;",
  "--cat-motion-fast:150ms;--cat-motion-base:220ms;--cat-motion-slow:250ms",
  "}",
  "*{box-sizing:border-box}",
  // Fallbacks are neutral dark surfaces, for hosts that mount without a
  // theme; themed hosts always override via appThemeCss.
  "body{margin:0;background:var(--color-bg,#0a0a0b);color:var(--color-fg,#e6e6e9);",
  "font-family:var(--font-sans);font-size:var(--cat-font-size);",
  "-webkit-font-smoothing:antialiased}",
].join("");
