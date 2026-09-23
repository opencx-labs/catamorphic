import fs from "node:fs";
import path from "node:path";
import {
  type HistoryEntry,
  type HistoryPage,
  type HistoryProject,
  type HistoryQuery,
  type HistoryVisit,
  historyEntrySchema,
  historyIdentity,
  isHistoryUrl,
} from "../shared/history.js";
import { siteOrigin } from "../shared/site-settings.js";
import type { ImportedHistoryEntry } from "./browser-import/types.js";

export interface HistorySuggestion {
  url: string;
  title: string;
  faviconUrl?: string;
}
const MAX_ENTRIES = 50_000;
const WRITE_DEBOUNCE_MS = 500;

/**
 * The profile's history (ADR 0153): web pages, files on this machine and
 * project resources in one store, each entry naming the project it was
 * opened in when there was one.
 */
export class HistoryStore {
  private cache = new Map<string, HistoryEntry[]>();
  private writes = new Map<string, ReturnType<typeof setTimeout>>();
  constructor(private readonly profilesDir: string) {}
  private file(profileId: string): string {
    return path.join(this.profilesDir, profileId, "history.json");
  }
  private load(profileId: string): HistoryEntry[] {
    const cached = this.cache.get(profileId);
    if (cached) return cached;
    const entries: HistoryEntry[] = [];
    try {
      const raw: unknown = JSON.parse(
        fs.readFileSync(this.file(profileId), "utf-8"),
      );
      if (Array.isArray(raw))
        for (const value of raw) {
          const parsed = historyEntrySchema.safeParse(value);
          if (parsed.success) entries.push(parsed.data);
        }
    } catch {
      /* A new profile has no history. */
    }
    this.cache.set(profileId, entries);
    return entries;
  }
  private flush(profileId: string): void {
    const entries = this.cache.get(profileId);
    if (!entries) return;
    const file = this.file(profileId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(entries), { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
  }
  private changed(profileId: string): void {
    const entries = this.load(profileId);
    if (entries.length > MAX_ENTRIES)
      this.cache.set(
        profileId,
        entries
          .sort((a, b) => b.lastVisitAt - a.lastVisitAt)
          .slice(0, MAX_ENTRIES),
      );
    clearTimeout(this.writes.get(profileId));
    this.writes.set(
      profileId,
      setTimeout(() => {
        this.writes.delete(profileId);
        try {
          this.flush(profileId);
        } catch {
          console.warn("[desktop] Could not save history");
        }
      }, WRITE_DEBOUNCE_MS),
    );
  }
  recordVisit({
    profileId,
    visit,
    revisit = true,
  }: {
    profileId: string;
    visit: HistoryVisit;
    revisit?: boolean;
  }): void {
    if (visit.target.kind === "web" && !isHistoryUrl(visit.target.url)) return;
    const entries = this.load(profileId);
    const id = historyIdentity(visit.target);
    const existing = entries.find((entry) => entry.id === id);
    if (existing)
      Object.assign(existing, visit, {
        lastVisitAt: revisit ? Date.now() : existing.lastVisitAt,
        visitCount: existing.visitCount + (revisit ? 1 : 0),
      });
    else if (revisit)
      entries.push({ ...visit, id, lastVisitAt: Date.now(), visitCount: 1 });
    else return;
    this.changed(profileId);
  }
  record({
    profileId,
    url,
    title,
    project,
  }: {
    profileId: string;
    url: string;
    title: string;
    project?: HistoryProject;
  }): void {
    this.recordVisit({
      profileId,
      visit: { target: { kind: "web", url }, title: title || url, project },
    });
  }
  import({
    profileId,
    entries: imported,
  }: {
    profileId: string;
    entries: ImportedHistoryEntry[];
  }): number {
    const entries = this.load(profileId);
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    let added = 0;
    for (const item of imported) {
      if (
        !isHistoryUrl(item.url) ||
        !Number.isFinite(item.lastVisitAt) ||
        item.lastVisitAt <= 0 ||
        item.lastVisitAt > Date.now() + 60_000
      )
        continue;
      const target = {
        kind: "web",
        url: item.url,
      } satisfies HistoryVisit["target"];
      const id = historyIdentity(target);
      const existing = byId.get(id);
      const visitCount = Number.isFinite(item.visitCount)
        ? Math.max(1, Math.floor(item.visitCount))
        : 1;
      if (existing) {
        if (item.lastVisitAt > existing.lastVisitAt) {
          existing.lastVisitAt = item.lastVisitAt;
          existing.title = item.title || item.url;
        }
        existing.visitCount = Math.max(existing.visitCount, visitCount);
      } else {
        const entry = {
          id,
          target,
          title: item.title || item.url,
          lastVisitAt: item.lastVisitAt,
          visitCount,
        };
        entries.push(entry);
        byId.set(id, entry);
        added++;
      }
    }
    this.changed(profileId);
    return added;
  }
  retitle(profileId: string, url: string, title: string): void {
    const entry = this.load(profileId).find(
      (item) => item.id === historyIdentity({ kind: "web", url }),
    );
    if (entry && title && entry.title !== title) {
      entry.title = title;
      this.changed(profileId);
    }
  }
  setFavicon(profileId: string, url: string, faviconUrl: string): void {
    const entry = this.load(profileId).find(
      (item) => item.id === historyIdentity({ kind: "web", url }),
    );
    if (entry && faviconUrl && entry.faviconUrl !== faviconUrl) {
      entry.faviconUrl = faviconUrl;
      this.changed(profileId);
    }
  }
  query({
    profileId,
    query = "",
    projectId,
    offset = 0,
    limit = 100,
  }: HistoryQuery & { profileId: string }): HistoryPage {
    const words = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
    const all = [...this.load(profileId)].sort(
      (a, b) => b.lastVisitAt - a.lastVisitAt,
    );
    const entries = all.filter((entry) => {
      if (projectId && entry.project?.id !== projectId) return false;
      const target =
        entry.target.kind === "web"
          ? entry.target.url
          : entry.target.kind === "local"
            ? entry.target.path
            : entry.target.resource;
      const haystack =
        `${entry.title} ${target} ${entry.project?.name ?? ""} ${entry.target.kind}`.toLocaleLowerCase();
      return words.every((word) => haystack.includes(word));
    });
    // Named from the latest visit, so a renamed project reads by its new name.
    const projects = new Map<string, HistoryProject>();
    for (const entry of all)
      if (entry.project && !projects.has(entry.project.id))
        projects.set(entry.project.id, entry.project);
    return {
      entries: entries.slice(
        Math.max(0, offset),
        Math.max(0, offset) + Math.min(200, Math.max(1, limit)),
      ),
      total: entries.length,
      projects: [...projects.values()],
    };
  }
  remove({ profileId, id }: { profileId: string; id: string }): void {
    this.cache.set(
      profileId,
      this.load(profileId).filter((entry) => entry.id !== id),
    );
    this.changed(profileId);
  }
  clear(profileId: string): void {
    this.cache.set(profileId, []);
    this.changed(profileId);
  }
  private web(profileId: string) {
    return this.load(profileId).flatMap((entry) =>
      entry.target.kind === "web" ? [{ ...entry, url: entry.target.url }] : [],
    );
  }
  suggest(profileId: string, query: string, limit = 5): HistorySuggestion[] {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    return this.web(profileId)
      .filter((e) => `${e.url} ${e.title}`.toLowerCase().includes(needle))
      .map((entry) => ({
        entry,
        score:
          entry.visitCount /
            (1 + (Date.now() - entry.lastVisitAt) / 86_400_000) +
          (entry.url.replace(/^https?:\/\/(www\.)?/, "").startsWith(needle)
            ? 10
            : 0),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ entry }) => ({
        url: entry.url,
        title: entry.title,
        faviconUrl: entry.faviconUrl,
      }));
  }
  inlineMatch(profileId: string, query: string): string | null {
    const needle = query.trim().toLowerCase();
    if (!needle) return null;
    return (
      this.web(profileId)
        .map((entry) => ({
          entry,
          bare: entry.url.replace(/^https?:\/\/(www\.)?/, ""),
        }))
        .filter(({ bare }) => bare.toLowerCase().startsWith(needle))
        .sort((a, b) => b.entry.visitCount - a.entry.visitCount)[0]?.bare ??
      null
    );
  }
  /** Latest visit and icon per site origin (Sites page, site settings). */
  siteVisits(
    profileId: string,
  ): Map<string, { lastVisitAt: number; faviconUrl: string | null }> {
    const sites = new Map<
      string,
      { lastVisitAt: number; faviconUrl: string | null }
    >();
    for (const entry of this.web(profileId)) {
      const origin = siteOrigin(entry.url);
      if (!origin) continue;
      const current = sites.get(origin);
      if (!current || entry.lastVisitAt > current.lastVisitAt)
        sites.set(origin, {
          lastVisitAt: entry.lastVisitAt,
          faviconUrl: entry.faviconUrl ?? current?.faviconUrl ?? null,
        });
      else if (!current.faviconUrl && entry.faviconUrl)
        current.faviconUrl = entry.faviconUrl;
    }
    return sites;
  }
  releaseProfile(profileId: string): void {
    clearTimeout(this.writes.get(profileId));
    this.writes.delete(profileId);
    this.cache.delete(profileId);
  }
  dispose(): void {
    for (const [profileId, timer] of this.writes) {
      clearTimeout(timer);
      try {
        this.flush(profileId);
      } catch {
        /* Best effort on quit. */
      }
    }
    this.writes.clear();
    this.cache.clear();
  }
}
