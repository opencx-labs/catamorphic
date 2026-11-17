import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import catalog from "./catalog.json";

const sha256 = /^[0-9a-f]{64}$/;
const pinned = (file: Record<string, unknown>) =>
  typeof file.path === "string" &&
  !file.path.includes("..") &&
  typeof file.sha256 === "string" &&
  sha256.test(file.sha256) &&
  typeof file.decompressedSha256 === "string" &&
  sha256.test(file.decompressedSha256) &&
  Number(file.bytes) > 0 &&
  Number(file.decompressedBytes) > 0;

describe("translation catalog", () => {
  it("pins the engine the vendored glue was built for", () => {
    expect(catalog.engine.version).toMatch(/^4\./);
    expect(pinned(catalog.engine)).toBe(true);
  });

  it("pins every file of every pair, each pair complete", () => {
    const entries = Object.entries(catalog.pairs);
    expect(entries.length).toBeGreaterThan(100);
    for (const [pair, entry] of entries) {
      expect(pair).toBe(`${entry.sourceLanguage}-${entry.targetLanguage}`);
      const files: Record<string, Record<string, unknown> | undefined> =
        entry.files;
      expect(files.model, pair).toBeDefined();
      expect(
        files.vocab ?? (files.srcvocab && files.trgvocab),
        pair,
      ).toBeTruthy();
      for (const file of Object.values(files))
        if (file) expect(pinned(file), pair).toBe(true);
    }
  });

  it("keeps the vendored glue the README pins", () => {
    const vendor = path.join(import.meta.dirname, "vendor");
    const glue = fs.readFileSync(path.join(vendor, "bergamot-translator.js"));
    const readme = fs.readFileSync(path.join(vendor, "README.md"), "utf8");
    const digest = createHash("sha256").update(glue).digest("hex");
    expect(readme).toContain(digest);
  });
});
