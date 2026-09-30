import {
  EMPTY_PALETTE_SIGNALS,
  type PaletteSignals,
  paletteQueryKey,
} from "../../shared/palette.js";
import {
  normalizeCommandQuery,
  prepareCommand,
  scorePreparedCommand,
} from "../lib/command-score.js";

export const PALETTE_RESULT_LIMIT = 80;

/**
 * What a row is, for ranking (ADR 0186). The prior says how likely a text
 * match on this kind of row is what the user meant: commands and app
 * surfaces are the palette's reason to exist, pages the long tail. A page
 * beats a command only with a clearly better match or much heavier use.
 */
export type PaletteCategory =
  | "command"
  | "surface"
  | "resource"
  | "setting"
  | "bookmark"
  | "page"
  | "choice";
const PRIOR: Record<PaletteCategory, number> = {
  command: 1,
  surface: 1,
  choice: 1,
  resource: 0.9,
  setting: 0.8,
  bookmark: 0.8,
  page: 0.6,
};
/**
 * A row the user keeps in a sidebar section is their own shortlist: it
 * ranks with commands, whatever kind of row it is.
 */
const SIDEBAR_PRIOR = 1;

export interface Rankable {
  label: string;
  keywords: readonly string[];
  /** Matched weakly: where a row lives, not what it is. */
  detail?: string;
  category?: PaletteCategory;
  /** Shown in a sidebar section: ranks with commands (`SIDEBAR_PRIOR`). */
  sidebar?: boolean;
  /** Usage key for frecency and learned picks. */
  usage?: string;
}

/** Frecency whose boost is half its maximum. */
const FRECENCY_HALF = 5;
const FRECENCY_WEIGHT = 0.5;
const LOCAL_BOOST = 0.1;
/** One fresh pick for a query lifts that row by half this. */
const PICK_WEIGHT = 1;

const saturate = (value: number, half: number) => value / (value + half);

/** "new t" matches at the start of "open new tab"'s second word. */
function atWordStart(text: string, query: string): boolean {
  let index = text.indexOf(query);
  while (index > 0) {
    if (/[\s/:._\-·]/.test(text[index - 1] ?? "")) return true;
    index = text.indexOf(query, index + 1);
  }
  return index === 0;
}

interface Entry<T> {
  item: T;
  label: string;
  keywords: string[];
  detail: string;
  command: ReturnType<typeof prepareCommand>;
  prior: number;
}

/**
 * Text match in [0, 1]: the label outranks keywords, keywords outrank the
 * detail, and fuzzy subsequences are a weak last resort.
 */
function literalScore<T>(entry: Entry<T>, query: string): number {
  const { label, keywords, detail } = entry;
  if (label === query) return 1;
  if (label.startsWith(query)) return 0.9;
  if (atWordStart(label, query)) return 0.8;
  if (label.includes(query)) return 0.65;
  if (keywords.some((word) => word === query || word.startsWith(query)))
    return 0.6;
  if (keywords.some((word) => atWordStart(word, query))) return 0.5;
  if (keywords.some((word) => word.includes(query))) return 0.4;
  if (detail && atWordStart(detail, query)) return 0.35;
  if (detail?.includes(query)) return 0.3;
  // Every word somewhere in the label or keywords: "tab new" still finds it.
  const words = query.split(" ").filter(Boolean);
  if (
    words.length > 1 &&
    words.every(
      (word) =>
        label.includes(word) || keywords.some((entry) => entry.includes(word)),
    )
  )
    return words.every((word) => label.includes(word)) ? 0.55 : 0.45;
  return 0;
}

/**
 * Weights for rows picked earlier with a related query: "se" and "set"
 * both learn from picking Settings after typing "sett".
 */
function pickWeights(
  signals: PaletteSignals,
  query: string,
): Map<string, number> {
  const weights = new Map<string, number>();
  const typed = paletteQueryKey(query);
  if (!typed) return weights;
  for (const [stored, picks] of Object.entries(signals.picks)) {
    if (!stored.startsWith(typed) && !typed.startsWith(stored)) continue;
    const overlap =
      Math.min(stored.length, typed.length) /
      Math.max(stored.length, typed.length);
    for (const [key, weight] of Object.entries(picks))
      weights.set(key, (weights.get(key) ?? 0) + weight * overlap);
  }
  return weights;
}

export interface PaletteRankContext {
  signals?: PaletteSignals;
  /** Use inside the current project counts a little more. */
  projectId?: string;
}

/** A row's use-based multiplier, also used to order the empty palette. */
export function usageBoost(
  usage: string | undefined,
  { signals = EMPTY_PALETTE_SIGNALS, projectId }: PaletteRankContext,
): number {
  const used = usage ? signals.usage[usage] : undefined;
  if (!used) return 1;
  return (
    1 +
    FRECENCY_WEIGHT * saturate(used.frecency, FRECENCY_HALF) +
    (projectId && used.projectId === projectId ? LOCAL_BOOST : 0)
  );
}

/** Prepare only when source data changes; never read settings or perform IO here. */
export function createPaletteIndex<T extends Rankable>(items: readonly T[]) {
  const entries: Entry<T>[] = items.map((item) => ({
    item,
    label: normalizeCommandQuery(item.label),
    keywords: item.keywords.map((word) => normalizeCommandQuery(word)),
    detail: item.detail ? normalizeCommandQuery(item.detail) : "",
    command: prepareCommand(item.label, item.keywords),
    prior: item.sidebar ? SIDEBAR_PRIOR : PRIOR[item.category ?? "command"],
  }));
  return (
    query: string,
    context: PaletteRankContext = {},
    limit = PALETTE_RESULT_LIMIT,
  ): T[] => {
    const trimmed = query.trim();
    if (!trimmed) return items.slice(0, limit);
    // Pasted prose belongs to the agent/web action, not recursive fuzzy matching.
    if (trimmed.length > 256 || trimmed.includes("\n")) return [];
    const lower = normalizeCommandQuery(trimmed).replace(/\s+/g, " ");
    const picks = pickWeights(context.signals ?? EMPTY_PALETTE_SIGNALS, lower);
    const matched = entries.map((entry) => ({
      entry,
      match: literalScore(entry, lower),
    }));
    const literal = matched.filter(({ match }) => match > 0).length;
    const scored = matched
      .map(({ entry, match }) => {
        const picked = entry.item.usage ? picks.get(entry.item.usage) : 0;
        // Literal matches express stronger intent. Fuzzy matching is the
        // fallback for abbreviations and typos, not noise beneath a literal
        // result, except for a row the user picked for this query before.
        const text =
          match ||
          (literal === 0 || picked
            ? 0.35 * scorePreparedCommand(entry.command, trimmed, lower)
            : 0);
        if (text <= 0) return null;
        return {
          item: entry.item,
          score:
            text * entry.prior * usageBoost(entry.item.usage, context) +
            PICK_WEIGHT * saturate(picked ?? 0, 1),
        };
      })
      .filter((entry) => entry !== null);
    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((entry) => entry.item);
  };
}

/**
 * The empty palette's "Frequent" rows: the most used destinations, each
 * once. Pages are capped so a heavily browsed site cannot crowd out the
 * app's own commands and surfaces, whose counts only grow through use.
 */
export function frequentItems<
  T extends Rankable & { id: string; disabled?: boolean },
>(
  candidates: readonly T[],
  {
    signals = EMPTY_PALETTE_SIGNALS,
    projectId,
    limit = 6,
    pageLimit = 3,
  }: PaletteRankContext & { limit?: number; pageLimit?: number },
): T[] {
  const seen = new Set<string>();
  const scored = candidates.flatMap((item) => {
    if (!item.usage || item.disabled || seen.has(item.usage)) return [];
    seen.add(item.usage);
    const used = signals.usage[item.usage];
    if (!used || used.frecency <= 0) return [];
    const local = projectId && used.projectId === projectId ? 1.1 : 1;
    return [{ item, score: used.frecency * local }];
  });
  scored.sort((a, b) => b.score - a.score);
  const chosen: T[] = [];
  let pages = 0;
  for (const { item } of scored) {
    if (chosen.length >= limit) break;
    const page = item.category === "page" || item.category === "bookmark";
    if (page && pages >= pageLimit) continue;
    if (page) pages += 1;
    chosen.push(item);
  }
  return chosen;
}
