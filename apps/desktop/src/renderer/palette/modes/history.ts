import { History } from "lucide-react";
import { useMemo } from "react";
import type { HistoryEntry } from "../../../shared/history.js";
import { BUILTIN_PALETTE_TRIGGERS } from "../../../shared/palette.js";
import { desktopApi } from "../../lib/desktop-api.js";
import { usePaletteHost } from "../host.js";
import type { PaletteItem, PaletteMode } from "../types.js";

/** Everything opened in this profile; the source searches the full history. */
export function useHistoryMode(
  historyRow: (entry: HistoryEntry) => PaletteItem,
): PaletteMode {
  const { profileId } = usePaletteHost();
  return useMemo(
    () => ({
      id: "history",
      chip: "History",
      icon: History,
      label: "Search history",
      description: "Find pages and work you opened",
      placeholder: "Search history…",
      names: profileId ? BUILTIN_PALETTE_TRIGGERS.history : undefined,
      rows: {
        kind: "load",
        key: `history:${profileId}`,
        filtered: true,
        debounceMs: 120,
        empty: "No history matches",
        load: async (typed) => ({
          items: (
            await desktopApi.historyQuery({ query: typed, limit: 80 })
          ).entries.map(historyRow),
        }),
      },
    }),
    [profileId, historyRow],
  );
}
