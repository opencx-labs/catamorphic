import {
  normalizeCommandQuery,
  prepareCommand,
  scorePreparedCommand,
} from "./command-score.js";
export const PALETTE_RESULT_LIMIT = 80;
/** Prepare only when source data changes; never read settings or perform IO here. */
export function createPaletteIndex<
  T extends { label: string; keywords: string[] },
>(items: readonly T[]) {
  const entries = items.map((item) => ({
    item,
    label: normalizeCommandQuery(item.label),
    command: prepareCommand(item.label, item.keywords),
  }));
  return (query: string, limit = PALETTE_RESULT_LIMIT): T[] => {
    const trimmed = query.trim();
    if (!trimmed) return items.slice(0, limit);
    // Pasted prose belongs to the agent/web action, not recursive fuzzy matching.
    if (trimmed.length > 256 || trimmed.includes("\n")) return [];
    const lower = normalizeCommandQuery(trimmed);
    const literal = entries
      .map((entry) => ({
        item: entry.item,
        score:
          entry.label === lower
            ? 2
            : entry.label.startsWith(lower)
              ? 1.5
              : entry.label.includes(lower)
                ? 1.25
                : entry.command.lower.includes(lower)
                  ? 1.1
                  : 0,
      }))
      .filter((entry) => entry.score > 0);
    // Literal matches express stronger intent. Fuzzy matching is the fallback
    // for abbreviations/typos, not extra noise beneath an exact result.
    const matches = literal.length
      ? literal
      : entries
          .map((entry) => ({
            item: entry.item,
            score: scorePreparedCommand(entry.command, trimmed, lower),
          }))
          .filter((entry) => entry.score > 0);
    return matches
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((entry) => entry.item);
  };
}
