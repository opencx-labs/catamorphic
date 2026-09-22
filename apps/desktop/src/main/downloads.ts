import { randomUUID } from "node:crypto";
import type { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import type { DownloadRecord, DownloadState } from "../shared/downloads.js";

const MAX_RECORDS = 500;
const WRITE_DEBOUNCE_MS = 500;
const BROADCAST_THROTTLE_MS = 100;

/** Per-profile download history: `profiles/<id>/downloads.json`. */
export class DownloadsStore {
  private cache = new Map<string, DownloadRecord[]>();
  private writes = new Map<string, ReturnType<typeof setTimeout>>();
  constructor(private readonly profilesDir: string) {}

  private file(profileId: string): string {
    return path.join(this.profilesDir, profileId, "downloads.json");
  }

  private load(profileId: string): DownloadRecord[] {
    const cached = this.cache.get(profileId);
    if (cached) return cached;
    let records: DownloadRecord[] = [];
    try {
      const raw: unknown = JSON.parse(
        fs.readFileSync(this.file(profileId), "utf-8"),
      );
      if (Array.isArray(raw))
        records = raw.filter(
          (entry): entry is DownloadRecord =>
            typeof entry === "object" &&
            entry !== null &&
            typeof entry.id === "string" &&
            typeof entry.savePath === "string" &&
            typeof entry.filename === "string",
        );
    } catch {
      /* Nothing downloaded yet. */
    }
    // A download in flight when the app last quit never finished.
    for (const record of records)
      if (record.state === "progressing" || record.state === "paused") {
        record.state = "interrupted";
        record.canResume = false;
      }
    this.cache.set(profileId, records);
    return records;
  }

  private flush(profileId: string): void {
    const records = this.cache.get(profileId);
    if (!records) return;
    const file = this.file(profileId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(records), { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
  }

  private changed(profileId: string): void {
    const records = this.load(profileId);
    if (records.length > MAX_RECORDS)
      this.cache.set(
        profileId,
        records.sort((a, b) => b.startedAt - a.startedAt).slice(0, MAX_RECORDS),
      );
    clearTimeout(this.writes.get(profileId));
    this.writes.set(
      profileId,
      setTimeout(() => {
        this.writes.delete(profileId);
        try {
          this.flush(profileId);
        } catch {
          console.warn("[desktop] Could not save downloads");
        }
      }, WRITE_DEBOUNCE_MS),
    );
  }

  list(profileId: string): DownloadRecord[] {
    return [...this.load(profileId)].sort((a, b) => b.startedAt - a.startedAt);
  }

  get(profileId: string, id: string): DownloadRecord | undefined {
    return this.load(profileId).find((record) => record.id === id);
  }

  upsert(profileId: string, record: DownloadRecord): void {
    const records = this.load(profileId);
    const index = records.findIndex((entry) => entry.id === record.id);
    if (index === -1) records.push(record);
    else records[index] = record;
    this.changed(profileId);
  }

  remove(profileId: string, id: string): void {
    this.cache.set(
      profileId,
      this.load(profileId).filter((record) => record.id !== id),
    );
    this.changed(profileId);
  }

  /** Drop everything that is not in flight. */
  clearFinished(profileId: string): void {
    this.cache.set(
      profileId,
      this.load(profileId).filter(
        (record) => record.state === "progressing" || record.state === "paused",
      ),
    );
    this.changed(profileId);
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
        /* best effort at exit */
      }
    }
    this.writes.clear();
  }
}

/** "report.pdf" → "report (1).pdf" while the name is taken, as Chrome does. */
export function uniqueSavePath(dir: string, filename: string): string {
  const safe = filename.replaceAll(/[\\/:\u0000]/g, "_").trim() || "download";
  const extension = path.extname(safe);
  const stem = safe.slice(0, safe.length - extension.length);
  let candidate = path.join(dir, safe);
  for (let n = 1; fs.existsSync(candidate); n += 1)
    candidate = path.join(dir, `${stem} (${n})${extension}`);
  return candidate;
}

/** What the manager needs of Electron's DownloadItem (mockable). */
export interface DownloadItemLike extends EventEmitter {
  getFilename(): string;
  getURL(): string;
  getMimeType(): string;
  getTotalBytes(): number;
  getReceivedBytes(): number;
  getState(): "progressing" | "completed" | "cancelled" | "interrupted";
  getStartTime(): number;
  isPaused(): boolean;
  canResume(): boolean;
  setSavePath(path: string): void;
  getSavePath(): string;
  pause(): void;
  resume(): void;
  cancel(): void;
}

function stateOf(item: DownloadItemLike): DownloadState {
  const state = item.getState();
  return state === "progressing" && item.isPaused() ? "paused" : state;
}

/**
 * Tracks each profile's downloads: assigns the save path, keeps the
 * record current while the bytes arrive, and tells the profile's windows
 * (throttled) so the dock ring and the Downloads page follow along.
 */
export class DownloadsManager {
  private readonly active = new Map<string, DownloadItemLike>();
  private readonly pendingBroadcast = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();

  constructor(
    readonly store: DownloadsStore,
    private readonly options: {
      downloadsDir: () => string;
      broadcast: (profileId: string, downloads: DownloadRecord[]) => void;
    },
  ) {}

  attach(profileId: string, item: DownloadItemLike, host: string | null) {
    const dir = this.options.downloadsDir();
    fs.mkdirSync(dir, { recursive: true });
    item.setSavePath(uniqueSavePath(dir, item.getFilename()));
    const id = randomUUID();
    const record = (): DownloadRecord => ({
      id,
      filename: path.basename(item.getSavePath()),
      url: item.getURL(),
      host,
      savePath: item.getSavePath(),
      mimeType: item.getMimeType(),
      totalBytes: item.getTotalBytes() || -1,
      receivedBytes: item.getReceivedBytes(),
      state: stateOf(item),
      startedAt: Math.round((item.getStartTime() || Date.now() / 1000) * 1000),
      finishedAt: null,
      exists: true,
      canResume: item.canResume(),
    });
    this.active.set(id, item);
    this.store.upsert(profileId, record());
    this.notify(profileId);
    item.on("updated", () => {
      this.store.upsert(profileId, record());
      this.notify(profileId);
    });
    item.once("done", () => {
      this.active.delete(id);
      const done = record();
      done.finishedAt = Date.now();
      done.exists = done.state === "completed" && fs.existsSync(done.savePath);
      this.store.upsert(profileId, done);
      this.notify(profileId, true);
    });
    return id;
  }

  private notify(profileId: string, now = false) {
    if (now) {
      clearTimeout(this.pendingBroadcast.get(profileId));
      this.pendingBroadcast.delete(profileId);
      this.options.broadcast(profileId, this.list(profileId));
      return;
    }
    if (this.pendingBroadcast.has(profileId)) return;
    this.pendingBroadcast.set(
      profileId,
      setTimeout(() => {
        this.pendingBroadcast.delete(profileId);
        this.options.broadcast(profileId, this.list(profileId));
      }, BROADCAST_THROTTLE_MS),
    );
  }

  /** Current records, with a fresh look at whether each file still exists. */
  list(profileId: string): DownloadRecord[] {
    return this.store
      .list(profileId)
      .map((record) =>
        record.state === "completed"
          ? { ...record, exists: fs.existsSync(record.savePath) }
          : record,
      );
  }

  pause(id: string): void {
    this.active.get(id)?.pause();
  }

  resume(id: string): void {
    const item = this.active.get(id);
    if (item?.canResume()) item.resume();
  }

  cancel(id: string): void {
    this.active.get(id)?.cancel();
  }

  remove(profileId: string, id: string): void {
    this.cancel(id);
    this.store.remove(profileId, id);
    this.notify(profileId, true);
  }

  clearFinished(profileId: string): void {
    this.store.clearFinished(profileId);
    this.notify(profileId, true);
  }

  dispose(): void {
    for (const timer of this.pendingBroadcast.values()) clearTimeout(timer);
    this.pendingBroadcast.clear();
    this.active.clear();
    this.store.dispose();
  }
}
