import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BrowserHistoryStore } from "./browser-history.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("BrowserHistoryStore", () => {
  it("returns the last observed favicon with recent pages", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "browser-history-"));
    dirs.push(dir);
    const history = new BrowserHistoryStore(dir);
    history.record("profile", "https://example.com/page", "Example");
    history.setFavicon(
      "profile",
      "https://example.com/page",
      "https://example.com/icon.png",
    );

    expect(history.recent("profile", 1)).toEqual([
      {
        url: "https://example.com/page",
        title: "Example",
        faviconUrl: "https://example.com/icon.png",
      },
    ]);
  });
});
