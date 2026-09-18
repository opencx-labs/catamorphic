import { readBrowserDatabase } from "./database.js";
import type { ImportedHistoryEntry } from "./types.js";

export function readBrowserHistory({
  file,
  firefox,
}: {
  file: string;
  firefox: boolean;
}): ImportedHistoryEntry[] {
  return readBrowserDatabase({
    file,
    read: (database) => {
      const rows = database.prepare(
        firefox
          ? "SELECT url, title, visit_count, last_visit_date / 1000.0 AS visited FROM moz_places WHERE last_visit_date > 0 ORDER BY last_visit_date DESC LIMIT 50000"
          : "SELECT url, title, visit_count, last_visit_time / 1000.0 AS visited FROM urls WHERE last_visit_time > 0 ORDER BY last_visit_time DESC LIMIT 50000",
      );
      const entries: ImportedHistoryEntry[] = [];
      for (const row of rows.iterate()) {
        if (typeof row.url !== "string" || typeof row.visited !== "number")
          continue;
        entries.push({
          url: row.url,
          title: typeof row.title === "string" ? row.title : row.url,
          visitCount: typeof row.visit_count === "number" ? row.visit_count : 1,
          lastVisitAt: row.visited - (firefox ? 0 : 11_644_473_600_000),
        });
      }
      return entries;
    },
  });
}
