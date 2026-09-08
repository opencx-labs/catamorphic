export interface ThemeFonts {
  sans: string;
  mono: string;
}

/** Keep these in sync with the pre-JS defaults in renderer/styles.css. */
export const DEFAULT_THEME_FONTS: ThemeFonts = {
  sans: '"Inter", system-ui, -apple-system, sans-serif',
  mono: '"JetBrains Mono", ui-monospace, "SF Mono", monospace',
};

// Literal CSS family names and comma-separated fallbacks. No CSS functions,
// declarations, or markup: these values also enter guest document styles.
const FONT_STACK_PATTERN =
  /^(?:"[\p{L}\p{N} _.-]+"|'[\p{L}\p{N} _.-]+'|[\p{L}_-][\p{L}\p{N} _-]*)(?:\s*,\s*(?:"[\p{L}\p{N} _.-]+"|'[\p{L}\p{N} _.-]+'|[\p{L}_-][\p{L}\p{N} _-]*))*$/u;

export function isValidFontStack(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length <= 200 &&
    FONT_STACK_PATTERN.test(value.trim())
  );
}
