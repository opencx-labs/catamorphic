import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tarArchive } from "../tar.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

function extract(archive: Buffer): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "work-tar-"));
  directories.push(directory);
  const file = path.join(directory, "archive.tar");
  fs.writeFileSync(file, archive);
  const out = path.join(directory, "out");
  fs.mkdirSync(out);
  execFileSync("tar", ["-xf", file, "-C", out]);
  return out;
}

describe("tarArchive", () => {
  it("writes files the system tar extracts, parents included", () => {
    const out = extract(
      tarArchive([
        { path: "a.txt", content: "alpha\n" },
        { path: "nested/deeper/b.json", content: '{"b":1}' },
        { path: "empty", content: "" },
        { path: "bytes.bin", content: new Uint8Array([0, 1, 2, 255]) },
      ]),
    );
    expect(fs.readFileSync(path.join(out, "a.txt"), "utf8")).toBe("alpha\n");
    expect(
      fs.readFileSync(path.join(out, "nested/deeper/b.json"), "utf8"),
    ).toBe('{"b":1}');
    expect(fs.readFileSync(path.join(out, "empty"), "utf8")).toBe("");
    expect([...fs.readFileSync(path.join(out, "bytes.bin"))]).toEqual([
      0, 1, 2, 255,
    ]);
  });

  it("carries paths longer than ustar's name field in PAX headers", () => {
    const long = `${"directory-name-".repeat(12)}/${"file-".repeat(30)}.txt`;
    const unicode = `ünïcødé/${"ü".repeat(60)}.txt`;
    expect(Buffer.byteLength(unicode)).toBeGreaterThan(100);
    const out = extract(
      tarArchive([
        { path: long, content: "long" },
        { path: unicode, content: "unicode" },
      ]),
    );
    expect(fs.readFileSync(path.join(out, long), "utf8")).toBe("long");
    expect(fs.readFileSync(path.join(out, unicode), "utf8")).toBe("unicode");
  });

  it("keeps file modes and pads to whole blocks", () => {
    const archive = tarArchive([
      { path: "run.sh", content: "#!/bin/sh\n", mode: 0o755 },
    ]);
    expect(archive.length % 512).toBe(0);
    const out = extract(archive);
    expect(fs.statSync(path.join(out, "run.sh")).mode & 0o777).toBe(0o755);
  });

  it("normalizes leading slashes and refuses paths that leave the base", () => {
    const out = extract(tarArchive([{ path: "/abs/./x.txt", content: "x" }]));
    expect(fs.readFileSync(path.join(out, "abs/x.txt"), "utf8")).toBe("x");
    expect(() => tarArchive([{ path: "../escape", content: "" }])).toThrow(
      "leaves the upload directory",
    );
    expect(() => tarArchive([{ path: "/", content: "" }])).toThrow(
      "names no file",
    );
  });
});
