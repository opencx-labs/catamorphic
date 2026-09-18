import { createCipheriv, createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { chromiumImporter } from "../chromium.js";
import {
  decryptCookie,
  importBrowserCookies,
  readBrowserCookies,
} from "../cookies.js";
import { readBrowserHistory } from "../history.js";

const dirs: string[] = [];
const fixture = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "browser-data-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

it("reads Chromium and Firefox history with their original timestamps from read-only stores", () => {
  const dir = fixture();
  const when = Date.now() - 86_400_000;
  for (const firefox of [false, true]) {
    const file = path.join(dir, firefox ? "places.sqlite" : "History");
    const db = new DatabaseSync(file);
    db.exec(
      firefox
        ? "CREATE TABLE moz_places (url TEXT, title TEXT, visit_count INTEGER, last_visit_date INTEGER)"
        : "CREATE TABLE urls (url TEXT, title TEXT, visit_count INTEGER, last_visit_time INTEGER)",
    );
    db.prepare(
      `INSERT INTO ${firefox ? "moz_places" : "urls"} VALUES (?, ?, ?, ?)`,
    ).run(
      "https://example.test/",
      "Example",
      7,
      (when + (firefox ? 0 : 11_644_473_600_000)) * 1000,
    );
    db.close();
    const before = fs.readFileSync(file);
    expect(readBrowserHistory({ file, firefox })).toEqual([
      {
        url: "https://example.test/",
        title: "Example",
        visitCount: 7,
        lastVisitAt: when,
      },
    ]);
    expect(fs.readFileSync(file)).toEqual(before);
  }
});

it("discovers history-only Chromium profiles and refuses linked or escaped stores", () => {
  const dir = fixture();
  fs.mkdirSync(path.join(dir, "Default"));
  fs.writeFileSync(path.join(dir, "Default", "History"), "fixture");
  const importer = chromiumImporter({
    id: "chrome",
    label: "Chrome",
    darwinDir: "unused",
    baseDirOverride: dir,
  });
  expect(importer.detect()?.profiles[0]).toMatchObject({
    id: "Default",
    hasHistory: true,
  });
  expect(importer.historyFile?.("../outside")).toBeNull();
  fs.unlinkSync(path.join(dir, "Default", "History"));
  fs.writeFileSync(path.join(dir, "elsewhere"), "fixture");
  fs.symlinkSync(
    path.join(dir, "elsewhere"),
    path.join(dir, "Default", "History"),
  );
  expect(importer.historyFile?.("Default")).toBeNull();
});

it("verifies the Chromium cookie host binding and skips unfamiliar encryption", () => {
  const key = Buffer.alloc(16, 7);
  const host = ".example.test";
  const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
  const encrypted = Buffer.concat([
    Buffer.from("v10"),
    cipher.update(
      Buffer.concat([
        createHash("sha256").update(host).digest(),
        Buffer.from("synthetic-session"),
      ]),
    ),
    cipher.final(),
  ]);
  expect(decryptCookie({ encrypted, key, host, version: 24 })).toBe(
    "synthetic-session",
  );
  expect(
    decryptCookie({ encrypted, key, host: ".other.test", version: 24 }),
  ).toBeNull();
  expect(
    decryptCookie({
      encrypted: Buffer.from("v20unavailable"),
      key,
      host,
      version: 24,
    }),
  ).toBeNull();
});

it("preserves host-only scope, secure flags, SameSite and expiry without flattening Firefox containers", async () => {
  const file = path.join(fixture(), "cookies.sqlite");
  const db = new DatabaseSync(file);
  db.exec(
    "CREATE TABLE moz_cookies (host TEXT, name TEXT, value TEXT, path TEXT, expiry INTEGER, isSecure INTEGER, isHttpOnly INTEGER, sameSite INTEGER, originAttributes TEXT)",
  );
  const expires = Math.floor(Date.now() / 1000) + 3600;
  const insert = db.prepare(
    "INSERT INTO moz_cookies VALUES (?, ?, ?, '/', ?, 1, 1, 1, ?)",
  );
  insert.run("example.test", "session", "synthetic", expires, "");
  insert.run(".example.test", "expired", "old", 1, "");
  insert.run(
    ".example.test",
    "container",
    "private",
    expires,
    "^userContextId=1",
  );
  db.close();
  const cookies = readBrowserCookies({
    source: { file, format: "firefox" },
    key: null,
  });
  expect(cookies).toEqual([
    {
      url: "https://example.test/",
      name: "session",
      value: "synthetic",
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "lax",
      expirationDate: expires,
    },
  ]);
  const save = vi.fn().mockResolvedValue(undefined);
  expect(
    await importBrowserCookies({
      cookies,
      existing: [{ name: "session", domain: "example.test", path: "/" }],
      save,
    }),
  ).toBe(0);
  expect(save).not.toHaveBeenCalled();
  expect(await importBrowserCookies({ cookies, existing: [], save })).toBe(1);
});

it("does not turn Chromium session cookies into persistent cookies or unpartition scoped cookies", () => {
  const file = path.join(fixture(), "Cookies");
  const db = new DatabaseSync(file);
  db.exec(
    "CREATE TABLE meta (key TEXT, value TEXT); INSERT INTO meta VALUES ('version', '24'); CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT, expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, has_expires INTEGER, samesite INTEGER, top_frame_site_key TEXT)",
  );
  db.prepare(
    "INSERT INTO cookies VALUES ('.example.test', 'session', 'synthetic', ?, '/', 0, 1, 1, 0, 2, '')",
  ).run(Buffer.alloc(0));
  db.prepare(
    "INSERT INTO cookies VALUES ('.example.test', 'partitioned', 'scoped', ?, '/', 0, 1, 1, 0, 2, 'https://other.test')",
  ).run(Buffer.alloc(0));
  db.close();
  const cookies = readBrowserCookies({
    source: { file, format: "chromium" },
    key: null,
  });
  expect(cookies).toHaveLength(1);
  expect(cookies[0]).toMatchObject({
    domain: ".example.test",
    sameSite: "strict",
  });
  expect(cookies[0]).not.toHaveProperty("expirationDate");
});
