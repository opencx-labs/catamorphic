import { z } from "zod";
import { type HistoryEntry, historyIdentity } from "./history.js";

/**
 * Palette ranking signals (ADR 0186). Frecency is visit count weighted by
 * how recent the sampled visits are, Firefox style: recent use counts
 * fully, old use fades without ever going negative.
 */
const DAY = 86_400_000;
const RECENCY_BUCKETS: Array<[maxDays: number, weight: number]> = [
  [4, 100],
  [14, 70],
  [31, 50],
  [90, 30],
  [Number.POSITIVE_INFINITY, 10],
];
function recencyWeight(age: number): number {
  const days = Math.max(0, age) / DAY;
  for (const [maxDays, weight] of RECENCY_BUCKETS)
    if (days <= maxDays) return weight;
  return 10;
}
/** One visit today scores 1; ten this week score 10; old use fades to a tenth. */
export function frecency({
  count,
  visits,
  now = Date.now(),
}: {
  count: number;
  /** Recent visit times (a sample; the newest few are enough). */
  visits: readonly number[];
  now?: number;
}): number {
  if (count <= 0 || visits.length === 0) return 0;
  const mean =
    visits.reduce((sum, at) => sum + recencyWeight(now - at), 0) /
    visits.length;
  return (count * mean) / 100;
}

/** Typed queries are keyed lowercased, trimmed and bounded. */
export function paletteQueryKey(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 64);
}

export interface PaletteUsage {
  frecency: number;
  /** The project this was last used in, when it was used inside one. */
  projectId?: string;
}
export interface PaletteSignals {
  /**
   * By usage key. History targets use their history identity; commands,
   * surfaces and other palette-only destinations use their row key.
   */
  usage: Record<string, PaletteUsage>;
  /** Typed query → usage key → how strongly it was picked for that query. */
  picks: Record<string, Record<string, number>>;
  /** The most frecent history entries, for the empty palette. */
  frequentHistory: HistoryEntry[];
}
export const EMPTY_PALETTE_SIGNALS: PaletteSignals = {
  usage: {},
  picks: {},
  frequentHistory: [],
};

export const paletteUseSchema = z.object({
  key: z.string().min(1).max(4096),
  /** What was typed when the row was picked; empty for zero-state picks. */
  query: z.string().max(4096).optional(),
  /**
   * Count a visit. False for targets history already counts (pages, chats,
   * workflows, apps, files), which still learn the typed query.
   */
  visit: z.boolean(),
  projectId: z.string().min(1).optional(),
});
export type PaletteUse = z.infer<typeof paletteUseSchema>;

/**
 * Tab-shaped surfaces reachable from the palette. Opening one from anywhere
 * (sidebar, shortcut, link) is a visit, like a page in history.
 */
export const PALETTE_SURFACE_KINDS = [
  "settings",
  "usage",
  "history",
  "sites",
  "downloads",
  "passwords",
] as const;
export type PaletteSurfaceKind = (typeof PALETTE_SURFACE_KINDS)[number];
export const surfaceUsageKey = (kind: PaletteSurfaceKind): string =>
  `surface:${kind}`;

/** A page's usage key is its history identity, so history counts rank it. */
export function webUsageKey(url: string): string {
  let href = url;
  try {
    href = new URL(url).href;
  } catch {
    /* Kept as written; it simply never matches a history entry. */
  }
  return historyIdentity({ kind: "web", url: href });
}

/**
 * Whether a palette pick counts as a visit. History counts pages and
 * project resources (keys are history identities, JSON arrays) and the
 * surface effect counts surfaces opened from anywhere; the palette counts
 * the rest (commands, settings, skills) so nothing is counted twice.
 */
export function paletteCountsVisit(key: string): boolean {
  return !key.startsWith("[") && !key.startsWith("surface:");
}

/**
 * Typed names the built-in modes own. Custom modes (sidebar.js
 * palette.modes) must pick other names; the renderer's built-in mode
 * definitions draw their triggers and aliases from this list. A full name
 * followed by Space enters its mode, so every name here is a word that
 * can no longer start an ordinary search: keep the list short.
 */
export const BUILTIN_PALETTE_TRIGGERS = {
  history: ["history"],
  files: ["files", "file"],
  content: ["content", "grep"],
  settings: ["settings", "preferences"],
  sites: ["sites"],
  commands: ["commands"],
  model: ["model"],
  effort: ["effort"],
  "permission-mode": ["permissions"],
  agent: ["agent", "chat"],
  web: ["web"],
} as const satisfies Record<string, readonly string[]>;
export type BuiltinPaletteMode = keyof typeof BUILTIN_PALETTE_TRIGGERS;
export const RESERVED_PALETTE_TRIGGERS: ReadonlySet<string> = new Set(
  Object.values(BUILTIN_PALETTE_TRIGGERS).flat(),
);
/** Lowercase letters, digits and dashes; a leading @ is dropped. */
export function normalizePaletteTrigger(value: string): string | null {
  const name = value.trim().replace(/^@/, "").toLowerCase();
  return /^[a-z0-9][a-z0-9-]{0,31}$/.test(name) ? name : null;
}
