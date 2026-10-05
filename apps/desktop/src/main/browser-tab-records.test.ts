import { EventEmitter } from "node:events";
import type { DownloadItem } from "electron";
import { describe, expect, it } from "vitest";
import { ConsoleLog, DownloadLog } from "./browser-tab-records.js";

describe("browser console log", () => {
  it("hands each read what is new since the last, and counts what the bound dropped", () => {
    const log = new ConsoleLog();
    log.add({ level: "info", text: "booted", source: "http://app/:1" });
    log.add({ level: "error", text: "failed", source: "http://app/:2" });
    expect(log.takeNew()).toEqual({
      messages: [
        { level: "info", text: "booted", source: "http://app/:1" },
        { level: "error", text: "failed", source: "http://app/:2" },
      ],
      dropped: 0,
    });
    expect(log.takeNew()).toEqual({ messages: [], dropped: 0 });
    for (let index = 0; index < 250; index++)
      log.add({ level: "debug", text: `line ${index}`, source: "x:1" });
    const next = log.takeNew();
    expect(next.dropped).toBe(50);
    expect(next.messages).toHaveLength(200);
    expect(next.messages[0]?.text).toBe("line 50");
  });

  it("bounds a long message", () => {
    const log = new ConsoleLog();
    log.add({ level: "warning", text: "x".repeat(5000), source: "x:1" });
    expect(log.takeNew().messages[0]?.text).toHaveLength(2000);
  });
});

describe("browser download log", () => {
  const item = (filename: string) => {
    const emitter = new EventEmitter();
    let received = 0;
    const fake = Object.assign(emitter, {
      getFilename: () => filename,
      getSavePath: () => `/downloads/${filename}`,
      getURL: () => `http://site/${filename}`,
      getTotalBytes: () => 10,
      getReceivedBytes: () => received,
      finish: (state: "completed" | "interrupted") => {
        received = 10;
        emitter.emit("done", {}, state);
      },
    });
    return fake;
  };
  const asDownload = (fake: ReturnType<typeof item>) =>
    fake as unknown as DownloadItem;

  it("waits for a download a click starts late, then for it to finish", async () => {
    const log = new DownloadLog();
    const pending = log.take(5000);
    const report = item("report.csv");
    setTimeout(() => log.add(asDownload(report)), 50);
    setTimeout(() => report.finish("completed"), 100);
    expect(await pending).toEqual({
      downloads: [
        expect.objectContaining({
          filename: "report.csv",
          path: "/downloads/report.csv",
          state: "completed",
          receivedBytes: 10,
        }),
      ],
    });
    // Nothing new and nothing unfinished: a read without a wait says so.
    expect((await log.take(0)).downloads).toHaveLength(1);
  });

  it("waits for one it last saw unfinished, and gives up at the timeout", async () => {
    const log = new DownloadLog();
    const big = item("big.zip");
    log.add(asDownload(big));
    expect((await log.take(0)).downloads[0]?.state).toBe("progressing");
    setTimeout(() => big.finish("interrupted"), 50);
    expect((await log.take(5000)).downloads[0]?.state).toBe("interrupted");
    const started = Date.now();
    expect((await log.take(100)).downloads).toHaveLength(1);
    expect(Date.now() - started).toBeGreaterThanOrEqual(90);
  });
});
