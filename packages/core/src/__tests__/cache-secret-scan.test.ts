import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cacheSizeCommand, secretScanScript } from "../services/cache-fills.js";

/** The search a cache check runs over a filled generation (ADR 0334). */
describe("the cache secret scan", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) {
      const locked = path.join(root, "cache", "locked");
      if (fs.existsSync(locked)) fs.chmodSync(locked, 0o600);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  const scan = (files: Record<string, string>, locked?: boolean) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cache-scan-"));
    roots.push(root);
    const patterns = path.join(root, "patterns");
    const cache = path.join(root, "cache");
    fs.mkdirSync(patterns);
    fs.mkdirSync(cache);
    fs.writeFileSync(
      path.join(patterns, "NPM_TOKEN"),
      "npm-token-value-0123\n",
    );
    for (const [name, content] of Object.entries(files))
      fs.writeFileSync(path.join(cache, name), content);
    if (locked) {
      fs.writeFileSync(path.join(cache, "locked"), "anything");
      fs.chmodSync(path.join(cache, "locked"), 0);
    }
    return spawnSync(
      "sh",
      ["-c", secretScanScript({ directory: patterns, path: cache })],
      { encoding: "utf8" },
    );
  };

  it("names a secret it finds and passes a clean cache", () => {
    const found = scan({ "a.json": '{"token":"npm-token-value-0123"}' });
    expect(found.status).toBe(0);
    expect(found.stdout.trim()).toBe("NPM_TOKEN");
    const clean = scan({ "a.json": "{}" });
    expect(clean.status).toBe(0);
    expect(clean.stdout.trim()).toBe("");
  });

  it.skipIf(process.getuid?.() === 0)(
    "fails when a file cannot be read, rather than calling it clean",
    () => {
      const unreadable = scan({ "a.json": "{}" }, true);
      expect(unreadable.status).toBe(3);
      expect(unreadable.stdout.trim()).toBe("");
    },
  );
});

/** The size a cache check measures (ADR 0334). */
describe("the cache size check", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) {
      const locked = path.join(root, "locked");
      if (fs.existsSync(locked)) fs.chmodSync(locked, 0o700);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  const measure = (locked?: boolean) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cache-size-"));
    roots.push(root);
    fs.writeFileSync(path.join(root, "package"), "x".repeat(64 * 1024));
    if (locked) {
      fs.mkdirSync(path.join(root, "locked"));
      fs.writeFileSync(path.join(root, "locked", "big"), "y".repeat(1024));
      fs.chmodSync(path.join(root, "locked"), 0);
    }
    return spawnSync("sh", ["-c", cacheSizeCommand(root)], {
      encoding: "utf8",
    });
  };

  it("answers the size in KiB", () => {
    const measured = measure();
    expect(measured.status).toBe(0);
    expect(Number.parseInt(measured.stdout.trim(), 10)).toBeGreaterThanOrEqual(
      64,
    );
  });

  it.skipIf(process.getuid?.() === 0)(
    "fails when du cannot read part of the cache, rather than undercounting",
    () => {
      expect(measure(true).status).not.toBe(0);
    },
  );
});
