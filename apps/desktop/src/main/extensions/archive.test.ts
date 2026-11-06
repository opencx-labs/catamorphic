import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ARCHIVE_LIMITS,
  ArchiveError,
  extractArchive,
  safeEntryPath,
} from "./archive.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "extension-archive-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("safeEntryPath", () => {
  it("keeps ordinary relative paths", () => {
    expect(safeEntryPath("manifest.json")).toBe("manifest.json");
    expect(safeEntryPath("js/background.js")).toBe("js/background.js");
    expect(safeEntryPath("_locales/en/")).toBe("_locales/en");
  });

  it("refuses paths that leave the folder", () => {
    for (const name of [
      "../evil.js",
      "a/../../evil.js",
      "/etc/passwd",
      "C:/Windows/evil.dll",
      "a\\..\\evil.js",
      "a//b",
      "./a",
      "",
      "a\0b",
    ])
      expect(safeEntryPath(name)).toBeNull();
  });
});

describe("extractArchive", () => {
  it("writes every file under the destination", () => {
    const destination = path.join(dir, "out");
    extractArchive(
      zipSync({
        "manifest.json": strToU8("{}"),
        "js/": new Uint8Array(),
        "js/bg.js": strToU8("self.x = 1"),
      }),
      destination,
    );
    expect(fs.readFileSync(path.join(destination, "js/bg.js"), "utf-8")).toBe(
      "self.x = 1",
    );
    expect(
      fs.readFileSync(path.join(destination, "manifest.json"), "utf-8"),
    ).toBe("{}");
  });

  it("refuses an archive with an escaping path and leaves nothing", () => {
    const destination = path.join(dir, "out");
    expect(() =>
      extractArchive(
        zipSync({ "../escape.js": strToU8("x"), "ok.js": strToU8("y") }),
        destination,
      ),
    ).toThrow(ArchiveError);
    expect(fs.existsSync(destination)).toBe(false);
    expect(fs.existsSync(path.join(dir, "escape.js"))).toBe(false);
  });

  it("enforces size and count limits before inflating", () => {
    const big = new Uint8Array(4096);
    expect(() =>
      extractArchive(zipSync({ "big.bin": big }), path.join(dir, "a"), {
        ...ARCHIVE_LIMITS,
        fileBytes: 1024,
      }),
    ).toThrow("too large");
    expect(() =>
      extractArchive(
        zipSync({ "a.js": strToU8("a"), "b.js": strToU8("b") }),
        path.join(dir, "b"),
        { ...ARCHIVE_LIMITS, entries: 1 },
      ),
    ).toThrow("too many files");
  });

  it("refuses to extract over an existing folder", () => {
    fs.mkdirSync(path.join(dir, "taken"));
    expect(() =>
      extractArchive(
        zipSync({ "a.js": strToU8("a") }),
        path.join(dir, "taken"),
      ),
    ).toThrow("already exists");
  });

  it("refuses a damaged archive", () => {
    expect(() =>
      extractArchive(strToU8("not a zip at all"), path.join(dir, "c")),
    ).toThrow(ArchiveError);
  });
});
