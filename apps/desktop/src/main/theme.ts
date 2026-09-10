import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_THEME_FONTS,
  isValidFontStack,
  type ThemeFonts,
} from "../shared/theme-fonts.js";
import { ConfigFile, readConfigObject } from "./config-file.js";

/**
 * Per-profile theme, stored at `<userData>/profiles/<id>/theme.json` so the
 * Settings UI, outside agents, and the user in a text editor can all edit
 * it. The file is watched and changes apply live — no restart.
 *
 * Format: `{ "selection": "system", "overrides": { "accent": "#ff5500" } }`.
 * `system` follows the operating system with the two Catamorphic presets.
 * The resolved theme is the selected preset's colors with overrides on top,
 * so a fully custom theme is just a selection with every token overridden.
 * Optional `fonts.sans` and `fonts.mono` override the desktop font stacks.
 */
export { THEME_TOKENS, type ThemeToken } from "../shared/theme-tokens.js";

import { THEME_TOKENS, type ThemeToken } from "../shared/theme-tokens.js";

export type ThemeColors = Record<ThemeToken, string>;

export interface ThemePreset {
  id: string;
  label: string;
  colors: ThemeColors;
}

export interface ThemeConfig {
  selection: string;
  overrides: Partial<ThemeColors>;
  fonts?: Partial<ThemeFonts>;
}

export interface ResolvedTheme extends ThemeConfig {
  fonts: ThemeFonts;
  /** Concrete preset after resolving the system selection. */
  preset: string;
  colors: ThemeColors;
  appearance: ThemeAppearance;
}

export type ThemeAppearance = "dark" | "light";

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
      sidebar: "#101012",
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
      bg: "#f7f8fa",
      "bg-raised": "#ffffff",
      "bg-overlay": "#eef0f3",
      "bg-inset": "#eceef1",
      sidebar: "#d9dce2",
      border: "#22252b1a",
      "border-strong": "#22252b33",
      fg: "#22252b",
      "fg-muted": "#555b65",
      "fg-faint": "#59616b",
      accent: "#d63c0c",
      "accent-fg": "#ffffff",
      success: "#4d7a3a",
      warning: "#d63c0c",
      danger: "#a04848",
      info: "#3a6ea0",
      "user-tint": "#e9edf3",
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
      sidebar: "#111826",
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
      sidebar: "#e8e2d2",
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
  // Community palette adaptations; attribution and licenses in THEME-NOTICES.md.
  {
    id: "catppuccin-latte",
    label: "Catppuccin Latte",
    colors: {
      bg: "#eff1f5",
      "bg-raised": "#ffffff",
      "bg-overlay": "#e6e9ef",
      "bg-inset": "#dce0e8",
      sidebar: "#e6e9ef",
      border: "#ccd0da",
      "border-strong": "#acb0be",
      fg: "#4c4f69",
      "fg-muted": "#5c5f77",
      "fg-faint": "#5c5f77",
      accent: "#7c2fda",
      "accent-fg": "#ffffff",
      success: "#2b6e1c",
      warning: "#85530c",
      danger: "#bf0d34",
      info: "#1858d4",
      "user-tint": "#e6e9ef",
      "agent-tint": "#ffffff",
    },
  },
  {
    id: "catppuccin-frappe",
    label: "Catppuccin Frappé",
    colors: {
      bg: "#303446",
      "bg-raised": "#303446",
      "bg-overlay": "#3a3e50",
      "bg-inset": "#232634",
      sidebar: "#292c3c",
      border: "#414559",
      "border-strong": "#626880",
      fg: "#c6d0f5",
      "fg-muted": "#b5bfe2",
      "fg-faint": "#a5adce",
      accent: "#ca9ee6",
      "accent-fg": "#232634",
      success: "#a6d189",
      warning: "#e5c890",
      danger: "#ea999c",
      info: "#8caaee",
      "user-tint": "#3a3e50",
      "agent-tint": "#303446",
    },
  },
  {
    id: "catppuccin-macchiato",
    label: "Catppuccin Macchiato",
    colors: {
      bg: "#24273a",
      "bg-raised": "#24273a",
      "bg-overlay": "#363a4f",
      "bg-inset": "#181926",
      sidebar: "#1e2030",
      border: "#363a4f",
      "border-strong": "#5b6078",
      fg: "#cad3f5",
      "fg-muted": "#b8c0e0",
      "fg-faint": "#a5adcb",
      accent: "#c6a0f6",
      "accent-fg": "#181926",
      success: "#a6da95",
      warning: "#eed49f",
      danger: "#ed8796",
      info: "#8aadf4",
      "user-tint": "#363a4f",
      "agent-tint": "#24273a",
    },
  },
  {
    id: "catppuccin-mocha",
    label: "Catppuccin Mocha",
    colors: {
      bg: "#1e1e2e",
      "bg-raised": "#1e1e2e",
      "bg-overlay": "#313244",
      "bg-inset": "#11111b",
      sidebar: "#181825",
      border: "#313244",
      "border-strong": "#585b70",
      fg: "#cdd6f4",
      "fg-muted": "#bac2de",
      "fg-faint": "#a6adc8",
      accent: "#cba6f7",
      "accent-fg": "#11111b",
      success: "#a6e3a1",
      warning: "#f9e2af",
      danger: "#f38ba8",
      info: "#89b4fa",
      "user-tint": "#313244",
      "agent-tint": "#1e1e2e",
    },
  },
  {
    id: "nord",
    label: "Nord",
    colors: {
      bg: "#2e3440",
      "bg-raised": "#3b4252",
      "bg-overlay": "#3b4252",
      "bg-inset": "#242933",
      sidebar: "#2e3440",
      border: "#434c5e",
      "border-strong": "#616e88",
      fg: "#eceff4",
      "fg-muted": "#d8dee9",
      "fg-faint": "#b8c3d7",
      accent: "#88c0d0",
      "accent-fg": "#2e3440",
      success: "#a3be8c",
      warning: "#ebcb8b",
      danger: "#e7a0a5",
      info: "#88c0d0",
      "user-tint": "#3b4252",
      "agent-tint": "#3b4252",
    },
  },
  {
    id: "rose-pine",
    label: "Rosé Pine",
    colors: {
      bg: "#191724",
      "bg-raised": "#1f1d2e",
      "bg-overlay": "#26233a",
      "bg-inset": "#15131f",
      sidebar: "#191724",
      border: "#403d52",
      "border-strong": "#524f67",
      fg: "#e0def4",
      "fg-muted": "#a8a3bc",
      "fg-faint": "#908caa",
      accent: "#ebbcba",
      "accent-fg": "#191724",
      success: "#9ccfd8",
      warning: "#f6c177",
      danger: "#eb6f92",
      info: "#9ccfd8",
      "user-tint": "#26233a",
      "agent-tint": "#1f1d2e",
    },
  },
  {
    id: "rose-pine-dawn",
    label: "Rosé Pine Dawn",
    colors: {
      bg: "#faf4ed",
      "bg-raised": "#fffaf3",
      "bg-overlay": "#f2e9e1",
      "bg-inset": "#f4ede8",
      sidebar: "#f2e9e1",
      border: "#dfdad9",
      "border-strong": "#cecacd",
      fg: "#575279",
      "fg-muted": "#6c6685",
      "fg-faint": "#6c6685",
      accent: "#9b5266",
      "accent-fg": "#fffaf3",
      success: "#286983",
      warning: "#8e5914",
      danger: "#9b5266",
      info: "#286983",
      "user-tint": "#f2e9e1",
      "agent-tint": "#fffaf3",
    },
  },
];

export const DEFAULT_THEME: ThemeConfig = {
  selection: "system",
  overrides: {},
};

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

/** Keep a known preset and valid color/font overrides; drop everything else. */
export function normalizeTheme(raw: unknown): ThemeConfig {
  const record =
    typeof raw === "object" && raw !== null
      ? (raw as Record<string, unknown>)
      : {};
  // `preset` was the pre-system-preference field. Reading it as an explicit
  // selection preserves an existing user's choice; newly absent files use
  // the system default.
  const requestedSelection =
    typeof record.selection === "string"
      ? record.selection
      : typeof record.preset === "string"
        ? record.preset
        : DEFAULT_THEME.selection;
  const selection =
    requestedSelection === "system"
      ? "system"
      : presetById(requestedSelection).id;
  const overrides: Partial<ThemeColors> = {};
  const rawOverrides =
    typeof record.overrides === "object" && record.overrides !== null
      ? (record.overrides as Record<string, unknown>)
      : {};
  for (const token of THEME_TOKENS) {
    const value = rawOverrides[token];
    if (isValidColor(value)) overrides[token] = value.trim();
  }
  const fonts: Partial<ThemeFonts> = {};
  if (typeof record.fonts === "object" && record.fonts !== null) {
    for (const token of ["sans", "mono"] as const) {
      const value = Reflect.get(record.fonts, token);
      if (isValidFontStack(value)) fonts[token] = value.trim();
    }
  }
  return {
    selection,
    overrides,
    ...(Object.keys(fonts).length > 0 ? { fonts } : {}),
  };
}

/** Preserve omitted settings so a personal edit does not freeze its parents. */
export function normalizeThemeLayer(raw: unknown): Partial<ThemeConfig> {
  const next = normalizeTheme(raw);
  const hasSelection =
    typeof raw === "object" &&
    raw !== null &&
    "selection" in raw &&
    (raw.selection === "system" ||
      THEME_PRESETS.some((preset) => preset.id === raw.selection));
  return {
    ...(hasSelection ? { selection: next.selection } : {}),
    overrides: next.overrides,
    ...(next.fonts ? { fonts: next.fonts } : {}),
  };
}

/** A selection replaces inherited color edits; token and font edits remain sparse. */
export function resolveThemeLayers(
  layers: readonly unknown[],
  systemAppearance: ThemeAppearance = "dark",
): ResolvedTheme {
  const config = layers.reduce<ThemeConfig>((current, raw) => {
    const next = normalizeThemeLayer(raw);
    return {
      selection: next.selection ?? current.selection,
      overrides: {
        ...(next.selection ? {} : current.overrides),
        ...next.overrides,
      },
      fonts: { ...current.fonts, ...next.fonts },
    };
  }, DEFAULT_THEME);
  return resolveTheme(config, systemAppearance);
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

export function resolveTheme(
  config: ThemeConfig,
  systemAppearance: ThemeAppearance = "dark",
): ResolvedTheme {
  const preset = presetById(
    config.selection === "system" ? systemAppearance : config.selection,
  );
  const colors = { ...preset.colors, ...config.overrides };
  // Appearance follows the actual background, not the preset: a dark preset
  // with the bg overridden to white must still get light scrollbars etc.
  const luminance = hexLuminance(colors.bg) ?? hexLuminance(preset.colors.bg);
  return {
    selection: config.selection,
    preset: preset.id,
    overrides: config.overrides,
    colors,
    fonts: { ...DEFAULT_THEME_FONTS, ...config.fonts },
    appearance: luminance !== null && luminance >= 0.5 ? "light" : "dark",
  };
}

/** The resolved bg as a hex BrowserWindow backgroundColor, with fallback. */
export function windowBackgroundColor(theme: ResolvedTheme): string {
  return /^#[0-9a-f]{6}$/i.test(theme.colors.bg)
    ? theme.colors.bg
    : presetById(theme.preset).colors.bg;
}

export function validateThemeConfig(raw: Record<string, unknown>): void {
  for (const key of ["selection", "preset"]) {
    const value = raw[key];
    if (
      value !== undefined &&
      value !== "system" &&
      !THEME_PRESETS.some((preset) => preset.id === value)
    )
      throw new Error(`Unknown theme ${key}`);
  }
  for (const family of ["overrides", "fonts"]) {
    const values = raw[family];
    if (values === undefined) continue;
    if (!values || typeof values !== "object" || Array.isArray(values))
      throw new Error(`${family} must be a JSON object`);
    for (const [key, value] of Object.entries(values)) {
      if (
        family === "fonts"
          ? !["sans", "mono"].includes(key) || !isValidFontStack(value)
          : !THEME_TOKENS.some((token) => token === key) || !isValidColor(value)
      )
        throw new Error(`Invalid theme ${family}.${key}`);
    }
  }
}

export class ThemeStore {
  private watcher: fs.FSWatcher | undefined;
  private debounce: ReturnType<typeof setTimeout> | undefined;

  private readonly config: ConfigFile;
  get error() {
    return this.config.error;
  }
  constructor(
    readonly file: string,
    private readonly systemAppearance: () => ThemeAppearance = () => "dark",
  ) {
    this.config = new ConfigFile(file, validateThemeConfig);
  }

  load(): ThemeConfig {
    return normalizeTheme(this.config.read());
  }

  save(config: ThemeConfig): void {
    const extras = Object.fromEntries(
      Object.entries(readConfigObject(this.file)).filter(
        ([key]) => !["selection", "preset", "overrides", "fonts"].includes(key),
      ),
    );
    this.config.write({ ...extras, ...config });
  }

  resolved(): ResolvedTheme {
    return resolveTheme(this.load(), this.systemAppearance());
  }

  /** Watch the containing directory (same rationale as KeybindingsStore). */
  watch(onChange: (theme: ResolvedTheme) => void): void {
    this.load();
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
