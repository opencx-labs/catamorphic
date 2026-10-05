import type { DownloadItem, WebContents } from "electron";

/** What a page printed to its console, as an agent reads it. */
export interface ConsoleEntry {
  level: "info" | "warning" | "error" | "debug";
  text: string;
  /** Where it was logged: "<url>:<line>". */
  source: string;
}

/** One file a tab downloaded, and where it was saved. */
export interface DownloadEntry {
  filename: string;
  path: string;
  url: string;
  state: "progressing" | "completed" | "cancelled" | "interrupted";
  receivedBytes: number;
  totalBytes: number;
}

const CONSOLE_KEPT = 200;
const TEXT_LIMIT = 2000;
const DOWNLOADS_KEPT = 50;

/**
 * A bounded log of one tab's console, from the moment the tab opens: what
 * a page printed while it loaded is there when an agent first asks. A read
 * takes what is new since the tab's last read.
 */
export class ConsoleLog {
  private entries: ConsoleEntry[] = [];
  /** Entries ever written; the log keeps the last {@link CONSOLE_KEPT}. */
  private written = 0;
  private read = 0;

  add(entry: ConsoleEntry): void {
    this.entries.push({
      ...entry,
      text:
        entry.text.length > TEXT_LIMIT
          ? `${entry.text.slice(0, TEXT_LIMIT - 1)}…`
          : entry.text,
    });
    this.written += 1;
    if (this.entries.length > CONSOLE_KEPT) this.entries.shift();
  }

  /** New entries since the last call, and how many were lost to the bound. */
  takeNew(): { messages: ConsoleEntry[]; dropped: number } {
    const kept = this.written - this.entries.length;
    const from = Math.max(this.read, kept);
    const messages = this.entries.slice(from - kept);
    const dropped = from - this.read;
    this.read = this.written;
    return { messages, dropped };
  }
}

/**
 * The files one tab downloaded, from the moment it opens, with where each
 * was saved and how far it got.
 */
export class DownloadLog {
  private entries: DownloadEntry[] = [];
  /** Entries ever added; a read waits for one newer than the last read. */
  private added = 0;
  private read = 0;
  /** The last read saw a download still in progress. */
  private unfinished = false;
  private waiters = new Set<() => void>();

  add(item: DownloadItem): void {
    const entry: DownloadEntry = {
      filename: item.getFilename(),
      path: item.getSavePath(),
      url: item.getURL().slice(0, 500),
      state: "progressing",
      receivedBytes: 0,
      totalBytes: item.getTotalBytes(),
    };
    const update = () => {
      entry.path = item.getSavePath() || entry.path;
      entry.receivedBytes = item.getReceivedBytes();
      entry.totalBytes = item.getTotalBytes();
      this.notify();
    };
    item.on("updated", (_event, state) => {
      update();
      if (state === "interrupted") entry.state = "interrupted";
    });
    item.once("done", (_event, state) => {
      update();
      entry.state = state;
      this.notify();
    });
    this.entries.push(entry);
    this.added += 1;
    if (this.entries.length > DOWNLOADS_KEPT) this.entries.shift();
    this.notify();
  }

  /**
   * Every download the tab knows, newest last. With a timeout, waits until
   * there is news (one newer than the last read, since a click's download
   * may take a while to start, or one the last read saw unfinished) and
   * none is still in progress.
   */
  async take(timeoutMs: number): Promise<{ downloads: DownloadEntry[] }> {
    const deadline = Date.now() + timeoutMs;
    const settled = () =>
      (this.added > this.read || this.unfinished) &&
      this.entries.every((entry) => entry.state !== "progressing");
    while (!settled() && Date.now() < deadline)
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          this.waiters.delete(done);
          resolve();
        };
        const timer = setTimeout(done, Math.max(0, deadline - Date.now()));
        this.waiters.add(done);
      });
    this.read = this.added;
    this.unfinished = this.entries.some(
      (entry) => entry.state === "progressing",
    );
    return { downloads: this.entries.map((entry) => ({ ...entry })) };
  }

  private notify(): void {
    for (const waiter of [...this.waiters]) waiter();
  }
}

const consoles = new WeakMap<WebContents, ConsoleLog>();
const downloads = new WeakMap<WebContents, DownloadLog>();

/** Record a browser tab's console from now on. */
export function trackConsole(contents: WebContents): void {
  if (consoles.has(contents)) return;
  const log = new ConsoleLog();
  consoles.set(contents, log);
  contents.on("console-message", (details) => {
    // Electron's own notices (development security warnings) are not the
    // page's.
    if (details.sourceId.startsWith("node:electron/")) return;
    log.add({
      level: details.level,
      text: details.message,
      source: `${details.sourceId}:${details.lineNumber}`,
    });
  });
}

/** Note a download a tab started. */
export function recordDownload(contents: WebContents, item: DownloadItem) {
  let log = downloads.get(contents);
  if (!log) {
    log = new DownloadLog();
    downloads.set(contents, log);
  }
  log.add(item);
}

/** The console of a tab, if it is recorded. */
export function consoleLogOf(contents: WebContents): ConsoleLog | undefined {
  return consoles.get(contents);
}

/** The downloads of a tab; an empty log when it has none yet. */
export function downloadLogOf(contents: WebContents): DownloadLog {
  let log = downloads.get(contents);
  if (!log) {
    log = new DownloadLog();
    downloads.set(contents, log);
  }
  return log;
}
