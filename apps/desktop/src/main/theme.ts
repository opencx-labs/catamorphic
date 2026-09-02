import fs from "node:fs";
import path from "node:path";

/**
 * Per-profile theme, stored at `<userData>/profiles/<id>/theme.json` so the
 * Settings UI, outside agents, and the user in a text editor can all edit
 * it. The file is watched and changes apply live — no restart.
 *
 * Format: `{ "preset": "dark", "overrides": { "accent": "#ff5500" } }`.
 * The resolved theme is the preset's colors with overrides on top, so a
 * fully custom theme is just a preset with every token overridden.
 */
export const THEME_TOKENS = [
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
  "user-tint",
  "agent-tint",
] as const;

export type ThemeToken = (typeof THEME_TOKENS)[number];
export type ThemeColors = Record<ThemeToken, string>;

export interface ThemePreset {
  id: string;
  label: string;
  colors: ThemeColors;
}

export interface ThemeConfig {
  preset: string;
  overrides: Partial<ThemeColors>;
}

export interface ResolvedTheme extends ThemeConfig {
  colors: ThemeColors;
  appearance: "dark" | "light";
}

export const THEME_PRESETS: ThemePreset[] = [
  {
    // The canonical Catamorphic look; must match the :root block in
    // renderer/styles.css (the pre-JS first-paint fallback).
    id: "dark",
    label: "Catamorphic Dark",
    colors: {
      bg: "#0a0a0b",
      "bg-raised": "#101012",
      "bg-overlay": "#16161a",
      "bg-inset": "#060607",
      border: "#232329",
      "border-strong": "#33333b",
      fg: "#e6e6e9",
      "fg-muted": "#9a9aa3",
      "fg-faint": "#5c5c66",
      accent: "#f95225",
      "accent-fg": "#1a0a05",
      success: "#7fb069",
      warning: "#f95225",
      danger: "#c46d6d",
      info: "#6d9ec4",
      "user-tint": "#14202e",
      "agent-tint": "#101012",
    },
  },
  {
    id: "light",
    label: "Catamorphic Light",
    colors: {
      bg: "#f7f7f5",
      "bg-raised": "#ffffff",
      "bg-overlay": "#efefec",
      "bg-inset": "#ececea",
      border: "#dcdcd7",
      "border-strong": "#c4c4bd",
      fg: "#1c1c1f",
      "fg-muted": "#5f5f66",
      "fg-faint": "#9a9aa0",
      accent: "#d63c0c",
      "accent-fg": "#ffffff",
      success: "#4d7a3a",
      warning: "#d63c0c",
      danger: "#a04848",
      info: "#3a6ea0",
      "user-tint": "#e3edf7",
      "agent-tint": "#ffffff",
    },
  },
  {
    id: "midnight",
    label: "Midnight",
    colors: {
      bg: "#0b1018",
      "bg-raised": "#111826",
      "bg-overlay": "#182234",
      "bg-inset": "#070b11",
      border: "#202b3d",
      "border-strong": "#2f3d54",
      fg: "#dde4ee",
      "fg-muted": "#8fa0b8",
      "fg-faint": "#55617a",
      accent: "#7aa2f7",
      "accent-fg": "#081018",
      success: "#86b380",
      warning: "#d9a05b",
      danger: "#c97878",
      info: "#6db3ce",
      "user-tint": "#152238",
      "agent-tint": "#111826",
    },
  },
  {
    id: "paper",
    label: "Paper",
    colors: {
      bg: "#f3eee3",
      "bg-raised": "#faf7ef",
      "bg-overlay": "#eae4d5",
      "bg-inset": "#e8e2d2",
      border: "#d6cdb8",
      "border-strong": "#bfb49a",
      fg: "#2b2620",
      "fg-muted": "#6b6153",
      "fg-faint": "#a09680",
      accent: "#a84e1f",
      "accent-fg": "#fffdf8",
      success: "#4e7a3a",
      warning: "#a84e1f",
      danger: "#a04840",
      info: "#3f6e8e",
      "user-tint": "#e2e8e4",
      "agent-tint": "#faf7ef",
    },
  },
];

export const DEFAULT_THEME: ThemeConfig = { preset: "dark", overrides: {} };

function presetById(id: string): ThemePreset {
  return (
    THEME_PRESETS.find((preset) => preset.id === id) ??
    (THEME_PRESETS[0] as ThemePreset)
  );
}

/** Hex colors, functional notation (rgb/hsl/oklch/color), or keywords. */
const COLOR_PATTERN =
  /^(#[0-9a-f]{3,8}|(rgb|rgba|hsl|hsla|oklch|color)\([^;{}<>]{1,80}\)|[a-z]{3,25})$/i;

export function isValidColor(value: unknown): value is string {
  return typeof value === "string" && COLOR_PATTERN.test(value.trim());
}

/** Keep a known preset and valid color overrides; drop everything else. */
export function normalizeTheme(raw: unknown): ThemeConfig {
  const record =
    typeof raw === "object" && raw !== null
      ? (raw as Record<string, unknown>)
      : {};
  const preset = presetById(
    typeof record.preset === "string" ? record.preset : DEFAULT_THEME.preset,
  ).id;
  const overrides: Partial<ThemeColors> = {};
  const rawOverrides =
    typeof record.overrides === "object" && record.overrides !== null
      ? (record.overrides as Record<string, unknown>)
      : {};
  for (const token of THEME_TOKENS) {
    const value = rawOverrides[token];
    if (isValidColor(value)) overrides[token] = value.trim();
  }
  return { preset, overrides };
}

/** Perceived luminance of a hex color, or null for non-hex values. */
function hexLuminance(color: string): number | null {
  const hex = /^#([0-9a-f]{6})/i.exec(
    color.length === 4
      ? `#${[...color.slice(1)].map((c) => c + c).join("")}`
      : color,
  )?.[1];
  if (!hex) return null;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [
    number,
    number,
    number,
  ];
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

export function resolveTheme(config: ThemeConfig): ResolvedTheme {
  const preset = presetById(config.preset);
  const colors = { ...preset.colors, ...config.overrides };
  // Appearance follows the actual background, not the preset: a dark preset
  // with the bg overridden to white must still get light scrollbars etc.
  const luminance = hexLuminance(colors.bg) ?? hexLuminance(preset.colors.bg);
  return {
    preset: preset.id,
    overrides: config.overrides,
    colors,
    appearance: luminance !== null && luminance >= 0.5 ? "light" : "dark",
  };
}

/** The resolved bg as a hex BrowserWindow backgroundColor, with fallback. */
export function windowBackgroundColor(theme: ResolvedTheme): string {
  return /^#[0-9a-f]{6}$/i.test(theme.colors.bg)
    ? theme.colors.bg
    : presetById(theme.preset).colors.bg;
}

export class ThemeStore {
  private watcher: fs.FSWatcher | undefined;
  private debounce: ReturnType<typeof setTimeout> | undefined;

  constructor(readonly file: string) {}

  load(): ThemeConfig {
    try {
      return normalizeTheme(JSON.parse(fs.readFileSync(this.file, "utf-8")));
    } catch {
      return { ...DEFAULT_THEME, overrides: {} };
    }
  }

  save(config: ThemeConfig): void {
    fs.writeFileSync(
      this.file,
      `${JSON.stringify(normalizeTheme(config), null, 2)}\n`,
    );
  }

  resolved(): ResolvedTheme {
    return resolveTheme(this.load());
  }

  /** Watch the containing directory (same rationale as KeybindingsStore). */
  watch(onChange: (theme: ResolvedTheme) => void): void {
    const dir = path.dirname(this.file);
    const name = path.basename(this.file);
    this.watcher = fs.watch(dir, (_event, changed) => {
      if (changed !== name) return;
      clearTimeout(this.debounce);
      this.debounce = setTimeout(() => onChange(this.resolved()), 100);
    });
  }

  dispose(): void {
    this.watcher?.close();
    clearTimeout(this.debounce);
  }
}
