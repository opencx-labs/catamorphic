import fs from "node:fs";
import path from "node:path";

/**
 * Per-profile browsing history backing the address-bar autocomplete.
 * Stored as plain JSON at `<userData>/profiles/<profileId>/history.json`.
 */
export interface HistoryEntry {
  url: string;
  title: string;
  visitCount: number;
  lastVisitAt: number;
}

export interface HistorySuggestion {
  url: string;
  title: string;
}

const MAX_ENTRIES = 2000;
const WRITE_DEBOUNCE_MS = 500;

export class BrowserHistoryStore {
  private cache = new Map<string, HistoryEntry[]>();
  private writes = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly profilesDir: string) {}

  private file(profileId: string): string {
    return path.join(this.profilesDir, profileId, "history.json");
  }

  private load(profileId: string): HistoryEntry[] {
    const cached = this.cache.get(profileId);
    if (cached) return cached;
    let entries: HistoryEntry[] = [];
    try {
      const raw = JSON.parse(fs.readFileSync(this.file(profileId), "utf-8"));
      if (Array.isArray(raw)) {
        entries = raw.filter(
          (entry): entry is HistoryEntry =>
            typeof entry?.url === "string" && typeof entry?.title === "string",
        );
      }
    } catch {
      // No history yet.
    }
    this.cache.set(profileId, entries);
    return entries;
  }

  private scheduleWrite(profileId: string): void {
    clearTimeout(this.writes.get(profileId));
    this.writes.set(
      profileId,
      setTimeout(() => {
        const entries = this.cache.get(profileId) ?? [];
        const file = this.file(profileId);
        try {
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, JSON.stringify(entries));
        } catch (cause) {
          console.warn("[desktop] failed to persist history:", cause);
        }
      }, WRITE_DEBOUNCE_MS),
    );
  }

  record(profileId: string, url: string, title: string): void {
    if (!/^https?:/.test(url)) return;
    let entries = this.load(profileId);
    const existing = entries.find((entry) => entry.url === url);
    if (existing) {
      existing.visitCount += 1;
      existing.lastVisitAt = Date.now();
      if (title) existing.title = title;
    } else {
      entries.push({
        url,
        title: title || url,
        visitCount: 1,
        lastVisitAt: Date.now(),
      });
      if (entries.length > MAX_ENTRIES) {
        entries = entries
          .sort((a, b) => b.lastVisitAt - a.lastVisitAt)
          .slice(0, MAX_ENTRIES);
      }
    }
    this.cache.set(profileId, entries);
    this.scheduleWrite(profileId);
  }

  /** Update the stored title once the page reports it (post-navigation). */
  retitle(profileId: string, url: string, title: string): void {
    if (!title) return;
    const entries = this.load(profileId);
    const entry = entries.find((candidate) => candidate.url === url);
    if (entry && entry.title !== title) {
      entry.title = title;
      this.scheduleWrite(profileId);
    }
  }

  /**
   * Chrome-style frecency: matches on URL or title, ranked by visit count
   * weighted with recency. The renderer composes the final suggestion rows
   * (search / go-to-URL first row) — this returns history matches only.
   */
  suggest(profileId: string, query: string, limit = 5): HistorySuggestion[] {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    const now = Date.now();
    return this.load(profileId)
      .filter(
        (entry) =>
          entry.url.toLowerCase().includes(needle) ||
          entry.title.toLowerCase().includes(needle),
      )
      .map((entry) => {
        const ageDays = (now - entry.lastVisitAt) / 86_400_000;
        const recency = ageDays < 1 ? 3 : ageDays < 7 ? 2 : 1;
        // Prefix matches on the bare host are what people re-type most.
        const bare = entry.url.replace(/^https?:\/\/(www\.)?/, "");
        const prefixBoost = bare.startsWith(needle) ? 10 : 0;
        return { entry, score: entry.visitCount * recency + prefixBoost };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ entry }) => ({ url: entry.url, title: entry.title }));
  }

  /** Best URL whose bare form starts with the input (inline autocomplete). */
  inlineMatch(profileId: string, query: string): string | null {
    const needle = query.trim().toLowerCase();
    if (!needle) return null;
    const matches = this.load(profileId)
      .map((entry) => ({
        entry,
        bare: entry.url.replace(/^https?:\/\/(www\.)?/, ""),
      }))
      .filter(({ bare }) => bare.toLowerCase().startsWith(needle))
      .sort((a, b) => b.entry.visitCount - a.entry.visitCount);
    return matches[0]?.bare ?? null;
  }

  dispose(): void {
    for (const [profileId, timer] of this.writes) {
      clearTimeout(timer);
      const entries = this.cache.get(profileId);
      if (!entries) continue;
      try {
        fs.mkdirSync(path.dirname(this.file(profileId)), { recursive: true });
        fs.writeFileSync(this.file(profileId), JSON.stringify(entries));
      } catch {
        // Best effort on shutdown.
      }
    }
    this.writes.clear();
  }
}
