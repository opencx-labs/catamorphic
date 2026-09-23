import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type DownloadItemLike,
  DownloadsManager,
  DownloadsStore,
  uniqueSavePath,
} from "./downloads.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "downloads-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

class FakeItem extends EventEmitter implements DownloadItemLike {
  savePath = "";
  received = 0;
  state: "progressing" | "completed" | "cancelled" | "interrupted" =
    "progressing";
  paused = false;
  constructor(
    private readonly filename: string,
    private readonly total: number,
  ) {
    super();
  }
  getFilename() {
    return this.filename;
  }
  getURL() {
    return `https://files.test/${this.filename}`;
  }
  getMimeType() {
    return "text/plain";
  }
  getTotalBytes() {
    return this.total;
  }
  getReceivedBytes() {
    return this.received;
  }
  getState() {
    return this.state;
  }
  getStartTime() {
    return 1_700_000_000;
  }
  isPaused() {
    return this.paused;
  }
  canResume() {
    return true;
  }
  setSavePath(value: string) {
    this.savePath = value;
  }
  getSavePath() {
    return this.savePath;
  }
  pause() {
    this.paused = true;
    this.emit("updated", {}, "progressing");
  }
  resume() {
    this.paused = false;
    this.emit("updated", {}, "progressing");
  }
  cancel() {
    this.state = "cancelled";
    this.emit("done", {}, "cancelled");
  }
  progress(bytes: number) {
    this.received = bytes;
    this.emit("updated", {}, "progressing");
  }
  finish() {
    this.received = this.total;
    this.state = "completed";
    fs.writeFileSync(this.savePath, "x".repeat(this.total));
    this.emit("done", {}, "completed");
  }
}

describe("uniqueSavePath", () => {
  it("numbers a taken name like Chrome and sanitizes separators", () => {
    fs.writeFileSync(path.join(dir, "report.pdf"), "");
    fs.writeFileSync(path.join(dir, "report (1).pdf"), "");
    expect(uniqueSavePath(dir, "report.pdf")).toBe(
      path.join(dir, "report (2).pdf"),
    );
    expect(uniqueSavePath(dir, "../evil/name.txt")).toBe(
      path.join(dir, ".._evil_name.txt"),
    );
    expect(uniqueSavePath(dir, "")).toBe(path.join(dir, "download"));
  });
});

describe("DownloadsManager", () => {
  it("records a download from start to completion and tells the windows", async () => {
    vi.useFakeTimers();
    const broadcasts: number[] = [];
    const manager = new DownloadsManager(new DownloadsStore(dir), {
      downloadsDir: () => path.join(dir, "Downloads"),
      broadcast: (_profile, downloads) =>
        broadcasts.push(downloads[0]?.receivedBytes ?? -1),
    });
    const item = new FakeItem("notes.txt", 10);
    const id = manager.attach("p1", item, "files.test");
    expect(item.savePath).toBe(path.join(dir, "Downloads", "notes.txt"));
    const started = manager.list("p1")[0];
    expect(started).toMatchObject({
      id,
      filename: "notes.txt",
      host: "files.test",
      state: "progressing",
      totalBytes: 10,
      receivedBytes: 0,
      startedAt: 1_700_000_000_000,
    });
    item.progress(4);
    item.progress(8);
    // Throttled: one broadcast per beat, not one per byte.
    vi.advanceTimersByTime(150);
    expect(broadcasts).toEqual([8]);
    manager.pause(id);
    expect(manager.list("p1")[0]?.state).toBe("paused");
    manager.resume(id);
    item.finish();
    const done = manager.list("p1")[0];
    expect(done?.state).toBe("completed");
    expect(done?.exists).toBe(true);
    expect(done?.finishedAt).not.toBeNull();
    expect(broadcasts.at(-1)).toBe(10);
    // A second file with the same name gets its own path.
    const again = new FakeItem("notes.txt", 3);
    manager.attach("p1", again, null);
    expect(again.savePath).toBe(path.join(dir, "Downloads", "notes (1).txt"));
    manager.dispose();
    vi.useRealTimers();
  });

  it("removes and clears, cancelling what is still in flight", () => {
    const manager = new DownloadsManager(new DownloadsStore(dir), {
      downloadsDir: () => path.join(dir, "Downloads"),
      broadcast: () => {},
    });
    const running = new FakeItem("a.bin", 5);
    const runningId = manager.attach("p1", running, null);
    const finished = new FakeItem("b.bin", 5);
    manager.attach("p1", finished, null);
    finished.finish();
    manager.clearFinished("p1");
    expect(manager.list("p1").map((record) => record.filename)).toEqual([
      "a.bin",
    ]);
    manager.remove("p1", runningId);
    expect(running.state).toBe("cancelled");
    expect(manager.list("p1")).toEqual([]);
    manager.dispose();
  });

  it("marks downloads left in flight at the last quit as interrupted", () => {
    fs.mkdirSync(path.join(dir, "p1"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "p1", "downloads.json"),
      JSON.stringify([
        {
          id: "x",
          filename: "old.zip",
          url: "https://a.test/old.zip",
          host: "a.test",
          savePath: path.join(dir, "old.zip"),
          mimeType: "application/zip",
          totalBytes: 100,
          receivedBytes: 40,
          state: "progressing",
          startedAt: 1,
          finishedAt: null,
          exists: true,
          canResume: true,
        },
      ]),
    );
    const store = new DownloadsStore(dir);
    expect(store.list("p1")[0]).toMatchObject({
      state: "interrupted",
      canResume: false,
    });
  });
});
