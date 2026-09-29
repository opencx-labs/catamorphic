import { useCallback, useMemo, useRef } from "react";
import type { HistoryEntry } from "../../../shared/history.js";
import { SiteFavicon } from "../../components/site-favicon.js";
import type { Bookmark } from "../../lib/desktop-api.js";
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
  bookmarks,
}: {
  query: string;
  enabled: boolean;
  bookmarks: readonly Bookmark[];
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
      bookmarked:
        entry.target.kind === "web" &&
        bookmarks.some(
          (bookmark) =>
            entry.target.kind === "web" &&
            bookmark.url.replace(/\/$/, "") ===
              entry.target.url.replace(/\/$/, ""),
        ),
      label: entry.title,
      detail: historyDetail(entry),
      keywords:
        entry.target.kind === "web"
          ? [hostOf(entry.target.url)]
          : entry.project
            ? [entry.project.name]
            : [],
      kind: "navigate",
      category:
        entry.target.kind === "web" || entry.target.kind === "local"
          ? "page"
          : "resource",
      usage: entry.id,
      run: (mode) => historyOpenRef.current(entry, mode),
    }),
    [bookmarks],
  );
  const historyItems = useMemo(
    () => historyResults.entries.map(historyRow),
    [historyResults.entries, historyRow],
  );
  return { historyRow, historyItems };
}
