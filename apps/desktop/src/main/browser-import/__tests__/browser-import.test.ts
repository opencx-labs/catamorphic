import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { chromiumImporter } from "../chromium.js";
import { firefoxImporter } from "../firefox.js";
import { BROWSER_IMPORTERS, readBrowserBookmarks } from "../index.js";
import { parsePasswordCsv } from "../password-csv.js";

/** Chromium bookmark tree node helpers. */
function url(name: string, href: string) {
  return { type: "url", name, url: href };
}
function folder(name: string, children: unknown[]) {
  return { type: "folder", name, children };
}

const tempDirs: string[] = [];
function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "browser-import-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

/** Fixture: a fake Chromium user-data dir with two profiles. */
function makeFixture(): string {
  const base = makeTempDir();
  writeJson(path.join(base, "Local State"), {
    profile: {
      info_cache: {
        Default: { name: "Work" },
        "Profile 1": { name: "Personal" },
      },
    },
  });
  writeJson(path.join(base, "Default", "Bookmarks"), {
    roots: {
      bookmark_bar: {
        children: [
          url("Root Link", "https://root.example.com"),
          folder("Dev", [
            url("GitHub", "https://github.com"),
            folder("Tools", [
              url("Vite", "https://vitejs.dev"),
              folder("CLI", [url("Bun", "https://bun.sh")]),
            ]),
          ]),
          url("Settings", "chrome://settings"),
          url("Bookmarklet", "javascript:alert(1)"),
          url("Root Link", "https://root.example.com"), // exact duplicate
        ],
      },
      other: {
        children: [url("Docs", "https://docs.example.com")],
      },
      synced: {
        children: [folder("Mobile", [url("News", "https://news.example.com")])],
      },
    },
  });
  // Corrupt bookmarks file: must be tolerated, never thrown.
  fs.mkdirSync(path.join(base, "Profile 1"), { recursive: true });
  fs.writeFileSync(path.join(base, "Profile 1", "Bookmarks"), "{not json!!");
  return base;
}

function makeImporter(base: string) {
  return chromiumImporter({
    id: "chrome",
    label: "Google Chrome",
    darwinDir: "Library/Application Support/Google/Chrome",
    baseDirOverride: base,
  });
}

describe("chromiumImporter.detect", () => {
  it("enumerates profiles from Local State with human names and counts", () => {
    const importer = makeImporter(makeFixture());
    const detected = importer.detect();
    expect(detected).not.toBeNull();
    expect(detected?.id).toBe("chrome");
    expect(detected?.label).toBe("Google Chrome");
    expect(detected?.profiles).toEqual([
      { id: "Default", name: "Work", bookmarkCount: 6 },
      { id: "Profile 1", name: "Personal", bookmarkCount: 0 },
    ]);
  });

  it("returns null when the base dir does not exist", () => {
    const importer = makeImporter(path.join(makeTempDir(), "nope"));
    expect(importer.detect()).toBeNull();
  });

  it("falls back to directory scanning when Local State is missing", () => {
    const base = makeTempDir();
    writeJson(path.join(base, "Default", "Bookmarks"), {
      roots: { bookmark_bar: { children: [url("A", "https://a.example")] } },
    });
    writeJson(path.join(base, "Profile 7", "Bookmarks"), { roots: {} });
    // A dir without a Bookmarks file is not a profile.
    fs.mkdirSync(path.join(base, "GrShaderCache"));
    const detected = makeImporter(base).detect();
    expect(detected?.profiles).toEqual([
      { id: "Default", name: "Default", bookmarkCount: 1 },
      { id: "Profile 7", name: "Profile 7", bookmarkCount: 0 },
    ]);
  });

  it("falls back to scanning when Local State is corrupt", () => {
    const base = makeTempDir();
    fs.writeFileSync(path.join(base, "Local State"), "garbage");
    writeJson(path.join(base, "Default", "Bookmarks"), {
      roots: { other: { children: [url("A", "https://a.example")] } },
    });
    const detected = makeImporter(base).detect();
    expect(detected?.profiles).toEqual([
      { id: "Default", name: "Default", bookmarkCount: 1 },
    ]);
  });
});

describe("chromiumImporter.readBookmarks", () => {
  const importer = makeImporter(makeFixture());
  const result = importer.readBookmarks("Default");

  it("retains complete folder ancestry at any depth", () => {
    const byLabel = new Map(result.bookmarks.map((b) => [b.label, b]));
    expect(byLabel.get("Root Link")?.folderPath).toBeUndefined();
    expect(byLabel.get("GitHub")?.folderPath).toEqual(["Dev"]);
    expect(byLabel.get("Vite")?.folderPath).toEqual(["Dev", "Tools"]);
    expect(byLabel.get("Bun")?.folderPath).toEqual(["Dev", "Tools", "CLI"]);
    expect(byLabel.get("Docs")?.folderPath).toBeUndefined();
    expect(byLabel.get("News")?.folderPath).toEqual(["Mobile"]);
  });

  it("skips non-http(s) URLs", () => {
    const urls = result.bookmarks.map((b) => b.url);
    expect(urls).not.toContain("chrome://settings");
    expect(urls.some((u) => u.startsWith("javascript:"))).toBe(false);
  });

  it("dedupes exact (url, label, folder path) triples", () => {
    const rootLinks = result.bookmarks.filter(
      (b) => b.url === "https://root.example.com",
    );
    expect(rootLinks).toHaveLength(1);
  });

  it("lists unique folder paths in first-seen order", () => {
    expect(result.folders).toEqual([
      { path: ["Dev"] },
      { path: ["Dev", "Tools"] },
      { path: ["Dev", "Tools", "CLI"] },
      { path: ["Mobile"] },
    ]);
  });

  it("returns 6 bookmarks total for the fixture", () => {
    expect(result.bookmarks).toHaveLength(6);
  });

  it("tolerates a corrupt Bookmarks file", () => {
    expect(importer.readBookmarks("Profile 1")).toEqual({
      folders: [],
      bookmarks: [],
    });
  });

  it("returns empty for an unknown profile", () => {
    expect(importer.readBookmarks("Profile 99")).toEqual({
      folders: [],
      bookmarks: [],
    });
  });
});

describe("index", () => {
  it("registers the six known browsers including Firefox", () => {
    expect(BROWSER_IMPORTERS.map((entry) => entry.id)).toEqual([
      "chrome",
      "edge",
      "brave",
      "arc",
      "chromium",
      "firefox",
    ]);
  });

  it("readBrowserBookmarks throws for an unknown browser id", () => {
    expect(() => readBrowserBookmarks("netscape", "Default")).toThrow(
      /unknown browser id/i,
    );
  });
});

describe("firefoxImporter", () => {
  it("discovers profiles.ini and imports live Places bookmarks", () => {
    const base = makeTempDir();
    const profile = path.join(base, "Profiles", "work.default-release");
    fs.mkdirSync(profile, { recursive: true });
    fs.writeFileSync(
      path.join(base, "profiles.ini"),
      [
        "[Profile0]",
        "Name=Work",
        "IsRelative=1",
        "Path=Profiles/work.default-release",
        "Default=1",
      ].join("\n"),
    );
    const database = new DatabaseSync(path.join(profile, "places.sqlite"));
    database.exec(`
      CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url TEXT);
      CREATE TABLE moz_bookmarks (
        id INTEGER PRIMARY KEY, type INTEGER, fk INTEGER, parent INTEGER,
        position INTEGER, title TEXT, guid TEXT
      );
      INSERT INTO moz_bookmarks VALUES
        (1, 2, NULL, 0, 0, 'Bookmarks Toolbar', 'toolbar_____'),
        (2, 2, NULL, 1, 0, 'Research', 'folder______'),
        (3, 1, 10, 5, 0, 'Example', 'example_____'),
        (4, 1, 11, 1, 1, 'Local', 'local_______'),
        (5, 2, NULL, 2, 0, 'AI', 'ai__________');
      INSERT INTO moz_places VALUES
        (10, 'https://example.com/path'),
        (11, 'http://localhost:3000');
    `);
    database.close();

    const importer = firefoxImporter({ baseDirOverride: base });
    expect(importer.detect()).toEqual({
      id: "firefox",
      label: "Firefox",
      profiles: [
        {
          id: "Profiles/work.default-release",
          name: "Work",
          bookmarkCount: 2,
        },
      ],
    });
    expect(importer.readBookmarks("Profiles/work.default-release")).toEqual({
      folders: [{ path: ["Research"] }, { path: ["Research", "AI"] }],
      bookmarks: [
        {
          label: "Example",
          url: "https://example.com/path",
          folderPath: ["Research", "AI"],
        },
        { label: "Local", url: "http://localhost:3000" },
      ],
    });
  });
});

describe("parsePasswordCsv", () => {
  it("accepts Chrome and Firefox exports, quoted fields, and valid web origins", () => {
    expect(
      parsePasswordCsv(
        [
          "name,url,username,password,note",
          'Example,https://example.com/login,person@example.com,"s,ec""ret",',
          "Unsafe,javascript:alert(1),user,nope,",
        ].join("\n"),
      ),
    ).toEqual([
      {
        origin: "https://example.com",
        username: "person@example.com",
        password: 's,ec"ret',
      },
    ]);

    expect(
      parsePasswordCsv("url,username,password\nhttps://mozilla.org,u,p"),
    ).toEqual([
      { origin: "https://mozilla.org", username: "u", password: "p" },
    ]);
  });

  it("rejects unrelated CSV files", () => {
    expect(() => parsePasswordCsv("title,address\nNope,example.com")).toThrow(
      /not a Chrome or Firefox password export/i,
    );
  });
});
