import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { readBrowserDatabase } from "../database.js";

const directories: string[] = [];
function fixture() {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "browser-snapshot-test-"),
  );
  directories.push(directory);
  const file = path.join(directory, "History");
  const source = new DatabaseSync(file);
  source.exec(
    "CREATE TABLE entries (value TEXT); INSERT INTO entries VALUES ('committed')",
  );
  return { file, source };
}
afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});
const read = (database: DatabaseSync) =>
  database.prepare("SELECT value FROM entries").all();

describe("browser SQLite snapshots", () => {
  it("reads a Chrome-style exclusive lock without altering or unlocking the source", () => {
    const { file, source } = fixture();
    try {
      source.exec("PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT;");
      const before = fs.readFileSync(file);
      const locked = new DatabaseSync(file, { readOnly: true });
      try {
        expect(() => read(locked)).toThrow(/locked/);
      } finally {
        locked.close();
      }
      expect(readBrowserDatabase({ file, read })).toEqual([
        { value: "committed" },
      ]);
      expect(fs.readFileSync(file)).toEqual(before);
      expect(read(source)).toEqual([{ value: "committed" }]);
    } finally {
      source.close();
    }
  });
  it("includes committed WAL data but excludes an uncommitted transaction", () => {
    const { file, source } = fixture();
    try {
      source.exec(
        "PRAGMA journal_mode=WAL; INSERT INTO entries VALUES ('wal'); BEGIN; INSERT INTO entries VALUES ('uncommitted');",
      );
      expect(readBrowserDatabase({ file, read })).toEqual([
        { value: "committed" },
        { value: "wal" },
      ]);
      source.exec("ROLLBACK");
    } finally {
      source.close();
    }
  });
  it("recovers a copied rollback journal without committing the source transaction", () => {
    const { file, source } = fixture();
    try {
      source.exec(
        "PRAGMA cache_size=1; BEGIN EXCLUSIVE; UPDATE entries SET value='uncommitted'; CREATE TABLE filler (value BLOB); INSERT INTO filler VALUES (zeroblob(100000));",
      );
      expect(readBrowserDatabase({ file, read })).toEqual([
        { value: "committed" },
      ]);
      expect(read(source)).toEqual([{ value: "uncommitted" }]);
      source.exec("ROLLBACK");
    } finally {
      source.close();
    }
  });
  it("refuses linked databases and journals and keeps callback writes query-only", () => {
    const { file, source } = fixture();
    source.close();
    const linked = `${file}.link`;
    fs.symlinkSync(file, linked);
    expect(() => readBrowserDatabase({ file: linked, read })).toThrow(
      /regular file/,
    );
    fs.symlinkSync(file, `${file}-wal`);
    expect(() => readBrowserDatabase({ file, read })).toThrow(/regular file/);
    fs.unlinkSync(`${file}-wal`);
    expect(() =>
      readBrowserDatabase({
        file,
        read: (database) => database.exec("DELETE FROM entries"),
      }),
    ).toThrow(/readonly/);
  });
});
