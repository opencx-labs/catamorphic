import { apiGet } from "./api.js";
import type { CompanionConnection } from "./store.js";

/**
 * The desktop theme model (apps/desktop/src/main/theme.ts), pure parts
 * only: same tokens, same presets, same resolution — change both together.
 * A project opts into a companion look by committing
 * `.catamorphic/theme.json` ({ "preset": "...", "overrides": {...} });
 * without one the app stays on Catamorphic Dark. No theme UI on mobile.
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

export interface ThemeConfig {
  preset: string;
  overrides: Partial<ThemeColors>;
}

export interface ResolvedTheme extends ThemeConfig {
  colors: ThemeColors;
  appearance: "dark" | "light";
}

interface ThemePreset {
  id: string;
  label: string;
  colors: ThemeColors;
}

const THEME_PRESETS: ThemePreset[] = [
  {
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

const COLOR_PATTERN =
  /^(#[0-9a-f]{3,8}|(rgb|rgba|hsl|hsla|oklch|color)\([^;{}<>]{1,80}\)|[a-z]{3,25})$/i;

export function isValidColor(value: unknown): value is string {
  return typeof value === "string" && COLOR_PATTERN.test(value.trim());
}

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
  const luminance = hexLuminance(colors.bg) ?? hexLuminance(preset.colors.bg);
  return {
    preset: preset.id,
    overrides: config.overrides,
    colors,
    appearance: luminance !== null && luminance >= 0.5 ? "light" : "dark",
  };
}

export const DEFAULT_RESOLVED_THEME = resolveTheme(DEFAULT_THEME);

/** Write a resolved theme onto the document (vars, appearance, chrome). */
export function applyTheme(theme: ResolvedTheme): void {
  const root = document.documentElement;
  for (const token of THEME_TOKENS) {
    root.style.setProperty(`--color-${token}`, theme.colors[token]);
  }
  root.style.colorScheme = theme.appearance;
  root.dataset.theme = theme.appearance;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", theme.colors.bg);
}

export const PROJECT_THEME_PATH = ".catamorphic/theme.json";

const projectThemes = new Map<string, ResolvedTheme | null>();

/**
 * The project's committed companion theme, if the caller may read it.
 * 403/404 (no such file, or a scope that doesn't cover it) is the normal
 * case and silently falls back to the default.
 */
export async function fetchProjectTheme(
  connection: Pick<CompanionConnection, "serverUrl" | "token">,
  projectId: string,
): Promise<ResolvedTheme | null> {
  const key = `${connection.serverUrl}:${projectId}`;
  const cached = projectThemes.get(key);
  if (cached !== undefined) return cached;
  let theme: ResolvedTheme | null = null;
  try {
    const response = await apiGet(
      connection,
      `/projects/${encodeURIComponent(projectId)}/documents/content?path=${encodeURIComponent(PROJECT_THEME_PATH)}`,
    );
    if (response.ok) {
      const body = (await response.json()) as { text?: string };
      if (body.text)
        theme = resolveTheme(normalizeTheme(JSON.parse(body.text)));
    }
  } catch {
    theme = null;
  }
  projectThemes.set(key, theme);
  return theme;
}
