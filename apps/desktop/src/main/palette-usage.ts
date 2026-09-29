import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { HistoryEntry } from "../shared/history.js";
import {
  frecency,
  type PaletteSignals,
  type PaletteUsage,
  type PaletteUse,
  paletteQueryKey,
} from "../shared/palette.js";

const VISIT_SAMPLES = 10;
const MAX_ITEMS = 2000;
const MAX_QUERIES = 500;
const MAX_PICKS_PER_QUERY = 8;
const HISTORY_SIGNALS = 1000;
const FREQUENT_HISTORY = 12;
const WRITE_DEBOUNCE_MS = 500;

const itemSchema = z.object({
  count: z.number().int().positive(),
  visits: z.array(z.number().finite().positive()).max(VISIT_SAMPLES),
  projectId: z.string().min(1).optional(),
});
const pickSchema = z.object({
  count: z.number().int().positive(),
  lastAt: z.number().finite().positive(),
});
const fileSchema = z.object({
  items: z.record(z.string(), itemSchema),
  picks: z.record(z.string(), z.record(z.string(), pickSchema)),
});
type UsageFile = z.infer<typeof fileSchema>;

/**
 * What the palette learns from use (ADR 0186), one file per profile: visits
 * to destinations history does not track (commands, surfaces, settings,
 * skills), and which row was picked for a typed query. Pages and project
 * resources keep their counts in history; signals merge both.
 */
export class PaletteUsageStore {
  private cache = new Map<string, UsageFile>();
  private writes = new Map<string, ReturnType<typeof setTimeout>>();
  constructor(private readonly profilesDir: string) {}
  private file(profileId: string): string {
    return path.join(this.profilesDir, profileId, "palette-usage.json");
  }
  private load(profileId: string): UsageFile {
    const cached = this.cache.get(profileId);
    if (cached) return cached;
    let data: UsageFile = { items: {}, picks: {} };
    try {
      const parsed = fileSchema.safeParse(
        JSON.parse(fs.readFileSync(this.file(profileId), "utf-8")),
      );
      if (parsed.success) data = parsed.data;
    } catch {
      /* A new profile has learned nothing yet. */
    }
    this.cache.set(profileId, data);
    return data;
  }
  private changed(profileId: string): void {
    clearTimeout(this.writes.get(profileId));
    this.writes.set(
      profileId,
      setTimeout(() => {
        this.writes.delete(profileId);
        this.flush(profileId);
      }, WRITE_DEBOUNCE_MS),
    );
  }
  private flush(profileId: string): void {
    const data = this.cache.get(profileId);
    if (!data) return;
    try {
      const file = this.file(profileId);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(data), { mode: 0o600 });
      fs.renameSync(`${file}.tmp`, file);
    } catch {
      console.warn("[desktop] Could not save palette usage");
    }
  }
  record({
    profileId,
    use,
    now = Date.now(),
  }: {
    profileId: string;
    use: PaletteUse;
    now?: number;
  }): void {
    const data = this.load(profileId);
    if (use.visit) {
      const item = data.items[use.key];
      data.items[use.key] = {
        count: (item?.count ?? 0) + 1,
        visits: [now, ...(item?.visits ?? [])].slice(0, VISIT_SAMPLES),
        ...(use.projectId ? { projectId: use.projectId } : {}),
      };
      const keys = Object.keys(data.items);
      if (keys.length > MAX_ITEMS) {
        const weakest = keys
          .map((key) => ({ key, score: this.score(data.items[key], now) }))
          .sort((a, b) => a.score - b.score)
          .slice(0, keys.length - MAX_ITEMS);
        for (const { key } of weakest) delete data.items[key];
      }
    }
    const query = paletteQueryKey(use.query ?? "");
    if (query) {
      const picks = { ...data.picks[query] };
      const pick = picks[use.key];
      picks[use.key] = { count: (pick?.count ?? 0) + 1, lastAt: now };
      const kept = Object.entries(picks)
        .sort(([, a], [, b]) => b.lastAt - a.lastAt)
        .slice(0, MAX_PICKS_PER_QUERY);
      // Re-insert so the object's key order tracks the newest query.
      delete data.picks[query];
      data.picks[query] = Object.fromEntries(kept);
      const queries = Object.keys(data.picks);
      for (const stale of queries.slice(
        0,
        Math.max(0, queries.length - MAX_QUERIES),
      ))
        delete data.picks[stale];
    }
    this.changed(profileId);
  }
  private score(
    item: UsageFile["items"][string] | undefined,
    now: number,
  ): number {
    return item ? frecency({ count: item.count, visits: item.visits, now }) : 0;
  }
  /**
   * Everything the palette ranks with, in one read: palette usage merged
   * with the most frecent history (pages, chats, workflows, apps, files).
   */
  signals({
    profileId,
    history,
    now = Date.now(),
  }: {
    profileId: string;
    history: readonly HistoryEntry[];
    now?: number;
  }): PaletteSignals {
    const data = this.load(profileId);
    const usage: Record<string, PaletteUsage> = {};
    const scored = history
      .map((entry) => ({
        entry,
        frecency: frecency({
          count: entry.visitCount,
          visits: [entry.lastVisitAt],
          now,
        }),
      }))
      .sort((a, b) => b.frecency - a.frecency)
      .slice(0, HISTORY_SIGNALS);
    for (const { entry, frecency: score } of scored)
      usage[entry.id] = {
        frecency: score,
        ...(entry.project ? { projectId: entry.project.id } : {}),
      };
    for (const [key, item] of Object.entries(data.items))
      usage[key] = {
        frecency: this.score(item, now),
        ...(item.projectId ? { projectId: item.projectId } : {}),
      };
    const picks: PaletteSignals["picks"] = {};
    for (const [query, entries] of Object.entries(data.picks))
      picks[query] = Object.fromEntries(
        Object.entries(entries).map(([key, pick]) => [
          key,
          frecency({ count: pick.count, visits: [pick.lastAt], now }),
        ]),
      );
    return {
      usage,
      picks,
      frequentHistory: scored
        .slice(0, FREQUENT_HISTORY)
        .map(({ entry }) => entry),
    };
  }
  /** Forget one destination (a history entry was removed). */
  forget(profileId: string, key: string): void {
    const data = this.load(profileId);
    delete data.items[key];
    for (const picks of Object.values(data.picks)) delete picks[key];
    this.changed(profileId);
  }
  /** Clearing history clears what the palette learned too: typed queries are history. */
  clear(profileId: string): void {
    this.cache.set(profileId, { items: {}, picks: {} });
    this.changed(profileId);
  }
  /** A deleted profile's pending write is dropped with it. */
  releaseProfile(profileId: string): void {
    clearTimeout(this.writes.get(profileId));
    this.writes.delete(profileId);
    this.cache.delete(profileId);
  }
  dispose(): void {
    for (const [profileId, timer] of this.writes) {
      clearTimeout(timer);
      this.flush(profileId);
    }
    this.writes.clear();
    this.cache.clear();
  }
}
