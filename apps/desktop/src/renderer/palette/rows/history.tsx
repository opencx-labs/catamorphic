import { useCallback, useMemo, useRef } from "react";
import type { HistoryEntry } from "../../../shared/history.js";
import { SiteFavicon } from "../../components/site-favicon.js";
import { historyDetail, historyIcon, useHistory } from "../../lib/history.js";
import { usePaletteHost } from "../host.js";
import type { PaletteItem } from "../types.js";
import { hostOf } from "../urls.js";

/**
 * History as palette rows: the unscoped palette's matches for the query
 * (the History mode loads its own) and the row builder both share.
 */
export function useHistoryRows({
  query,
  enabled,
  bookmarkedUsage,
}: {
  query: string;
  enabled: boolean;
  /** Usage keys of bookmarked pages: a page's key is its history identity. */
  bookmarkedUsage: ReadonlySet<string>;
}) {
  const { profileId, onOpenHistory } = usePaletteHost();
  const historyResults = useHistory({
    query,
    limit: 80,
    enabled: Boolean(profileId) && enabled,
    profileId,
  });
  const historyOpenRef = useRef(onOpenHistory);
  historyOpenRef.current = onOpenHistory;
  const historyRow = useCallback(
    (entry: HistoryEntry): PaletteItem => ({
      id: `history:${entry.id}`,
      icon: historyIcon(entry),
      iconNode:
        entry.target.kind === "web" && entry.faviconUrl ? (
          <SiteFavicon
            url={entry.target.url}
            faviconUrl={entry.faviconUrl}
            className="size-4"
          />
        ) : undefined,
      bookmarked: bookmarkedUsage.has(entry.id),
      label: entry.title,
      detail: historyDetail(entry),
      keywords:
        entry.target.kind === "web"
          ? [hostOf(entry.target.url)]
          : entry.project
            ? [entry.project.name]
            : [],
      kind: "navigate",
      // A page the user saved ranks as the bookmark it is.
      category: bookmarkedUsage.has(entry.id)
        ? "bookmark"
        : entry.target.kind === "web" || entry.target.kind === "local"
          ? "page"
          : "resource",
      usage: entry.id,
      run: (mode) => historyOpenRef.current(entry, mode),
    }),
    [bookmarkedUsage],
  );
  const historyItems = useMemo(
    () => historyResults.entries.map(historyRow),
    [historyResults.entries, historyRow],
  );
  return { historyRow, historyItems, historyEntries: historyResults.entries };
}
